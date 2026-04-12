// Minimal OFT scoring engine (served under www/ for Shiny)
(function(){
  const TOOL_VERSION = "0.1.0";
  let TASK_CONFIG = "config/open_field.yaml";

  // State and event timelines
  let stateTimeline = []; // entries: {start: seconds, state: 'EDGE'|'CENTER'}
  let eventTimeline = []; // entries: {start, end, event}
  let activeEvents = {}; // eventName -> startTime
  let subjectInTime = null; // seconds when subject placed in apparatus
  let savedAutosave = null; // raw autosave stash (do not auto-apply)
  let manualFlags = [];
  let eventTypes = null; // array of event type objects {name, key}
  let stateTypes = null; // array of state names from config
  let additionalForState = {}; // map: stateName -> array of {field,label,type}
  let stateKeyMap = {};
  let DEFAULT_DURATION = 600;
  const eventTableBodies = {}; // map: eventName -> tbody element
  // Known task -> abbreviation mapping (derived from config YAMLs)
  const TASK_ABBREV_MAP = {
    open_field: 'OFT',
    light_dark: 'LD',
    elevated_plus: 'EPM'
  };
  // When true, a task change was initiated automatically (e.g. from filename detection)
  // and the change handler should not clear the currently selected video/file.
  let suppressClearOnTaskSwitch = false;

  // DOM
  const videoFile = document.getElementById('videoFile');
  const video = document.getElementById('videoPlayer');
  const videoFileDisplay = document.getElementById('videoFileDisplay');
  const changeSpeed = document.getElementById('changeSpeed');
  const speedInc = document.getElementById('speedInc');
  const speedDec = document.getElementById('speedDec');
  const markInBtn = document.getElementById('markIn');
  const clearInBtn = document.getElementById('clearIn');
  const subjectInDisplay = document.getElementById('subjectInDisplay');
  const currentStateDisplay = document.getElementById('currentStateDisplay');
  const videoDurInput = document.getElementById('videoDur');
  const stepInput = document.getElementById('stepSize');
  const addStateBtn = document.getElementById('addState');
  const addStateGroup = document.getElementById('addStateGroup');
  const addStateSelect = document.getElementById('addStateSelect');
  const setStateBtn = document.getElementById('setStateBtn');
  const stateTableBody = document.getElementById('stateTableBody');
  const eventTablesContainer = document.getElementById('eventTablesContainer');
  const startEventBtn = document.getElementById('startEvent');
  const stopEventBtn = document.getElementById('stopEvent');
  const eventTypeSel = document.getElementById('eventType');
  const exportJsonBtns = document.querySelectorAll('.exportJson');
  const exportCsvBtn = document.getElementById('exportCsv');
  const clearAllBtn = document.getElementById('clearAll');
  const importJsonFile = document.getElementById('importJsonFile');
  const setStartStateBtn = document.getElementById('setStartState');
  const startStateSel = document.getElementById('startState');
  const taskTypeSel = document.getElementById('taskType');
  const definitionsBody = document.getElementById('definitionsBody');

  

  function seconds(){ return video.currentTime || 0; }

  function isWithinSession(t){
    if(typeof t !== 'number' || subjectInTime == null) return false;
    const end = sessionEnd();
    return (t >= subjectInTime - 1e-6) && (t <= end + 1e-6);
  }

  function sessionEnd(){
    if(subjectInTime === null) return Infinity;
    const pd = (videoDurInput && videoDurInput.value) ? parseFloat(videoDurInput.value) : 600;
    return subjectInTime + (Number.isNaN(pd)? DEFAULT_DURATION : pd);
  }

  function showConflictModal(message, choices, cb){
    // small in-page modal with buttons for choices array [{key:'M',label:'Merge'}]
    try{
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed'; overlay.style.left = 0; overlay.style.top = 0; overlay.style.right = 0; overlay.style.bottom = 0;
      overlay.style.background = 'rgba(0,0,0,0.4)'; overlay.style.zIndex = 99998; overlay.style.display = 'flex'; overlay.style.alignItems='center'; overlay.style.justifyContent='center';
      const box = document.createElement('div'); box.style.background='white'; box.style.padding='16px'; box.style.borderRadius='8px'; box.style.maxWidth='480px'; box.style.width='90%';
      const p = document.createElement('div'); p.textContent = message; p.style.marginBottom = '12px';
      box.appendChild(p);
      const btnRow = document.createElement('div'); btnRow.style.display='flex'; btnRow.style.gap='8px';
      choices.forEach(ch=>{
        const b = document.createElement('button'); b.className = 'btn btn-sm btn-primary'; b.textContent = ch.label;
        b.addEventListener('click', ()=>{ try{ overlay.remove(); cb(ch.key); }catch(e){} });
        btnRow.appendChild(b);
      });
      const cancel = document.createElement('button'); cancel.className = 'btn btn-sm btn-secondary ms-2'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', ()=>{ try{ overlay.remove(); cb(null); }catch(e){} });
      box.appendChild(btnRow); box.appendChild(cancel);
      overlay.appendChild(box); document.body.appendChild(overlay);
    }catch(e){ cb(null); }
  }

  function updateStateControlsUI(){
    try{
      if(stateTypes && stateTypes.length >= 3){
        // show select + start button, hide single add button
        if(addStateBtn) addStateBtn.classList.add('d-none');
        if(addStateGroup) addStateGroup.classList.remove('d-none');
        if(addStateSelect){ addStateSelect.innerHTML = ''; stateTypes.forEach(s=>{ const o = document.createElement('option'); o.value = s; o.textContent = s; addStateSelect.appendChild(o); }); }
      } else {
        if(addStateBtn) addStateBtn.classList.remove('d-none');
        if(addStateGroup) addStateGroup.classList.add('d-none');
      }
    }catch(e){}
  }

  function handleConflict(idx){
    // pause video
    try{ video.pause(); }catch(e){}
    const current = stateTimeline[idx];
    const prev = (idx>0)? stateTimeline[idx-1]: null;
    const next = (idx+1 < stateTimeline.length)? stateTimeline[idx+1]: null;
    const message = `A duplicate state was detected around the inserted transition at ${formatTimeSec(current.start)}. Choose how to resolve:`;
    const choices = [
      {key:'M', label: 'Merge (remove future duplicate)'},
      {key:'S', label: 'Add + swap future states'},
      {key:'I', label: 'Insert Complement (mark for review)'},
      {key:'D', label: 'Delete Future (remove later stamps)'}
    ];
    showConflictModal(message, choices, (choice)=>{
      if(!choice) return; // cancelled
      if(choice === 'M'){
        // remove future duplicate (prefer next)
        if(next && next.state === current.state){ stateTimeline.splice(idx+1, 1); }
        else if(prev && prev.state === current.state){ // fallback: remove current
          stateTimeline.splice(idx,1);
        }
      }
      else if(choice === 'I'){
        // insert complementary state between current and next
        let comp = null;
        try{
          if(stateTypes && Array.isArray(stateTypes) && stateTypes.length>0){
            const curIdx = stateTypes.indexOf(current.state);
            comp = stateTypes[(curIdx + 1) % stateTypes.length];
          } else {
            comp = current.state === 'EDGE' ? 'CENTER' : 'EDGE';
          }
        }catch(e){ comp = current.state === 'EDGE' ? 'CENTER' : 'EDGE'; }
        let nextStart = sessionEnd();
        if(next && typeof next.start === 'number') nextStart = next.start;
        let mid = current.start + Math.min(0.5, Math.max(0.001, (nextStart - current.start)/2));
        if(mid <= current.start) mid = current.start + 0.001;
        const newEntry = {start: +mid.toFixed(3), state: comp, manual_flag: 'complementary'};
        stateTimeline.splice(idx+1, 0, newEntry);
        manualFlags.push({type:'complementary', at_s: newEntry.start, note: 'Inserted complementary placeholder'});
      }
      else if(choice === 'D'){
        // delete all future stamps after idx
        stateTimeline.splice(idx+1);
      }
      else if(choice === 'S'){
        // advance all future states in the configured state sequence (cycle)
        try{
          if(stateTypes && Array.isArray(stateTypes) && stateTypes.length>0){
            for(let j = idx+1; j < stateTimeline.length; j++){
              const s = stateTimeline[j];
              if(s && typeof s.state === 'string'){
                const cur = stateTypes.indexOf(s.state);
                s.state = stateTypes[(cur + 1) % stateTypes.length];
              }
            }
          } else {
            for(let j = idx+1; j < stateTimeline.length; j++){
              const s = stateTimeline[j];
              if(s && typeof s.state === 'string') s.state = (s.state === 'EDGE'? 'CENTER' : 'EDGE');
            }
          }
        }catch(e){ console.error('swap future error', e); }
      }
      // re-render and save
      renderStateList(); saveAutosave();
    });
  }

  function formatTimeSec(t){
    if(t === null || t === undefined || Number.isNaN(t)) return '—';
    const s = Number(t);
    const hours = Math.floor(s/3600);
    const mins = Math.floor((s%3600)/60);
    const secs = Math.floor(s%60);
    const ms = Math.floor((s - Math.floor(s)) * 1000);
    if(hours>0){ return `${hours.toString().padStart(2,'0')}:${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}.${ms.toString().padStart(3,'0')}`; }
    return `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}.${ms.toString().padStart(3,'0')}`;
  }

  function parseTimeToSec(ts){
    if(ts === null || ts === undefined) return NaN;
    const s = String(ts).trim();
    if(s === '') return NaN;
    // If purely numeric, treat as seconds
    if(/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    // Split on colons for HH:MM:SS.ms or MM:SS.ms
    const parts = s.split(':').map(p=>p.trim()).filter(p=>p.length>0);
    if(parts.length === 0) return NaN;
    let seconds = 0;
    try{
      // right-most part is seconds (may include decimal)
      let secPart = parts.pop();
      seconds += parseFloat(secPart);
      if(parts.length>0){ // minutes
        const minPart = parts.pop(); seconds += parseFloat(minPart) * 60;
      }
      if(parts.length>0){ // hours
        const hrPart = parts.pop(); seconds += parseFloat(hrPart) * 3600;
      }
      if(Number.isNaN(seconds)) return NaN;
      return seconds;
    }catch(e){ return NaN; }
  }

  function renderSubjectIn(){
    let txt = `Subject in: ${subjectInTime!==null? formatTimeSec(subjectInTime): '—'}`;
    // if duration available, show computed session end time
    let dur = null;
    if(videoDurInput && videoDurInput.value){ const p = parseFloat(videoDurInput.value); if(!Number.isNaN(p)) dur = p; }
    if(subjectInTime !== null && dur !== null){ const endt = subjectInTime + dur; txt += ` — session end: ${formatTimeSec(endt)}`; }
    subjectInDisplay.textContent = txt;
  }

  function getStateAt(time){
    if(typeof time !== 'number' || stateTimeline.length === 0) return null;
    // return the last state with start <= time
    let picked = null;
    for(let i=0;i<stateTimeline.length;i++){
      const s = stateTimeline[i];
      if(typeof s.start === 'number' && s.start <= time + 1e-9) picked = s;
      else if(typeof s.start === 'number' && s.start > time) break;
    }
    return picked;
  }

  function updateCurrentStateDisplay(){
    if(!currentStateDisplay) return;
    try{
      const now = (video && typeof video.currentTime === 'number') ? video.currentTime : null;
      if(now === null || subjectInTime === null || now < subjectInTime - 1e-6){ currentStateDisplay.textContent = 'Current state: —'; return; }
      const s = getStateAt(now);
      if(!s){ currentStateDisplay.textContent = 'Current state: —'; return; }
      // show state and when it started (relative seconds)
      currentStateDisplay.textContent = `Current state: ${s.state} (since ${formatTimeSec(s.start)})`;
    }catch(e){ currentStateDisplay.textContent = 'Current state: —'; }
  }

  videoFile.addEventListener('change', (e)=>{
    const f = e.target.files[0];
    if(!f) return;
    // preserve previous loaded video/file state so canceling doesn't remove it
    const prevVideoSrc = (video && video.getAttribute && video.getAttribute('src')) ? video.getAttribute('src') : (video && video.src ? video.src : null);
    const prevDatasetFilename = (video && video.dataset) ? (video.dataset.filename || '') : '';
    const prevFileInputValue = videoFile ? videoFile.value : '';
    const prevDisplayText = videoFileDisplay ? videoFileDisplay.textContent : '';

    const blobUrl = URL.createObjectURL(f);
    video.src = blobUrl;
    video.dataset.filename = f.name;
    if(videoFileDisplay) videoFileDisplay.textContent = `File: ${f.name}`;

    const handleFileAccepted = ()=>{
        // If the selected file is different from the previously loaded file,
      // clear testing/session metadata so it doesn't persist across files.
      try{
        if(prevDatasetFilename && prevDatasetFilename !== f.name){
          try{ if(document.getElementById('scorer')) document.getElementById('scorer').value = ''; }catch(e){}
          try{ if(document.getElementById('subjectId')) document.getElementById('subjectId').value = ''; }catch(e){}
          try{ if(document.getElementById('date')) document.getElementById('date').value = ''; }catch(e){}
          try{ if(document.getElementById('time')) document.getElementById('time').value = ''; }catch(e){}
        }
      }catch(e){}
      
      // try to auto-select task type based on filename (match known abbreviations or task names)
      try{
        const fname = (f.name || '').toLowerCase();
        let matched = null;
        Object.keys(TASK_ABBREV_MAP).forEach(task =>{
          try{
            const ab = String(TASK_ABBREV_MAP[task] || '').toLowerCase();
            const taskLower = String(task || '').toLowerCase();
            if(!ab) return;
            if(fname.includes(ab) || fname.includes(taskLower) || fname.includes(taskLower.replace('_',''))){ matched = task; }
          }catch(e){}
        });
        if(matched){
          if(taskTypeSel){ try{ suppressClearOnTaskSwitch = true; taskTypeSel.value = matched; taskTypeSel.dispatchEvent(new Event('change')); }catch(e){} }
          else { TASK_CONFIG = `config/${matched}.yaml`; try{ loadConfig(); }catch(e){} }
        }
      }catch(e){}
      // try to extract testing metadata (subjectId/date/time) from filename
      try{
        (function fillFromFilename(fn){
          if(!fn) return;
          const base = fn.split('/').pop().replace(/\.[^.]+$/, '');
          try{
            const parts = base.split('_');
            // Look for a YYYY-MM-DD token in parts
            let dateIdx = -1;
            for(let i=0;i<parts.length;i++){ if(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(parts[i])){ dateIdx = i; break; } }
            if(dateIdx !== -1){
              const date = parts[dateIdx];
              const subj = (dateIdx>0)? parts[dateIdx-1] : null;
              let time = null;
              if(parts.length > dateIdx+1){
                const tpart = parts[dateIdx+1];
                const tm = tpart.match(/([0-9]{2}-[0-9]{2}-[0-9]{2})/);
                if(tm) time = tm[1].replace(/-/g,':');
              }
              if(subj){ try{ if(document.getElementById('subjectId') && !document.getElementById('subjectId').value) document.getElementById('subjectId').value = subj; }catch(e){} }
              if(date){ try{ if(document.getElementById('date') && !document.getElementById('date').value) document.getElementById('date').value = date; }catch(e){} }
              if(time){ try{ if(document.getElementById('time') && !document.getElementById('time').value) document.getElementById('time').value = time; }catch(e){} }
              return;
            }
            // Pattern: YYYYMMDD_SUBJ_... (allow additional suffix like _OFT/_oft after subject)
            if(/^[0-9]{8}_/.test(base)){
              const tokens = base.split('_');
              if(tokens.length >= 2 && /^[0-9]{8}$/.test(tokens[0])){
                const d8 = tokens[0];
                const subj = tokens[1];
                const date = `${d8.slice(0,4)}-${d8.slice(4,6)}-${d8.slice(6,8)}`;
                try{ if(document.getElementById('subjectId') && !document.getElementById('subjectId').value) document.getElementById('subjectId').value = subj; }catch(e){}
                try{ if(document.getElementById('date') && !document.getElementById('date').value) document.getElementById('date').value = date; }catch(e){}
                return;
              }
            }

            // Pattern: YYYY-MM-DD-<SUFFIX>_... e.g. 2025-09-29-1914_OFT.MP4
            // capture date and the next hyphenated token as subject (also set time if token looks like HHMM)
            try{
              const tok0 = base.split('_')[0];
              const dm = tok0.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})-(.+)$/);
              if(dm){
                const date = dm[1];
                const subjToken = dm[2];
                // Treat the token after the date as the subject identifier.
                // Do NOT interpret 4-digit tokens as time by default because
                // subjects may be numeric of varying lengths (e.g., 1914).
                try{ if(document.getElementById('subjectId') && !document.getElementById('subjectId').value) document.getElementById('subjectId').value = subjToken; }catch(e){}
                try{ if(document.getElementById('date') && !document.getElementById('date').value) document.getElementById('date').value = date; }catch(e){}
                return;
              }
            }catch(e){}
            // Pattern: YYYY-MM-DD_SUBJ_...
            const m2 = base.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})_([A-Za-z0-9-]+)/);
            if(m2){ const date = m2[1]; const subj = m2[2]; try{ if(document.getElementById('subjectId') && !document.getElementById('subjectId').value) document.getElementById('subjectId').value = subj; }catch(e){} try{ if(document.getElementById('date') && !document.getElementById('date').value) document.getElementById('date').value = date; }catch(e){} return; }
          }catch(e){}
        })(f.name);
      }catch(e){}
      // apply selected playback speed when loading a file
      const sp = parseFloat(changeSpeed && changeSpeed.value) || 1.0;
      video.playbackRate = sp;
      // If there's a saved autosave that matches this video's filename, offer to restore it as a backup.
      try{
        // Consider it a real autosave only if it contains timeline/event entries or a recorded subject placement.
        const savedHasAnnotations = savedAutosave && (
          (savedAutosave.stateTimeline && savedAutosave.stateTimeline.length>0) ||
          (savedAutosave.eventTimeline && savedAutosave.eventTimeline.length>0) ||
          (savedAutosave.metadata && savedAutosave.metadata.subject_in_time_s != null)
        );
        try{ console.log('autosave-restore-check', { savedHasAnnotations, savedAutosave }); }catch(e){}
        if(savedAutosave && savedAutosave.metadata && savedAutosave.metadata.video_file && savedAutosave.metadata.video_file === f.name && savedHasAnnotations){
          const ok = confirm('Found a local autosave for this video. Restore annotations from local backup?');
          if(ok) applyAutosave(savedAutosave);
        }
      }catch(e){}
    };

    try{
      const savedFile = (savedAutosave && savedAutosave.metadata && savedAutosave.metadata.video_file) ? String(savedAutosave.metadata.video_file) : null;
      // Only warn if the current page already has annotations (i.e. autosave not just present in storage
      // but not applied to the page). If the page is fresh (no annotations loaded), proceed silently.
      const pageHasAnnotations = (stateTimeline && stateTimeline.length>0) || (eventTimeline && eventTimeline.length>0) || (subjectInTime !== null) || (activeEvents && Object.keys(activeEvents).length>0);
      if(savedFile && savedFile !== f.name && pageHasAnnotations){
        const msg = `Selected file "${f.name}" differs from annotations saved for "${savedFile}". Proceeding may mismatch timestamps.`;
        const choices = [ {key:'E', label: 'Export & clear'}, {key:'L', label: 'Clear and load new file'}, {key:'C', label: 'Cancel file selection'} ];
          showConflictModal(msg, choices, (choice)=>{
            // treat modal dismissal (null/undefined) same as explicit Cancel
            if(!choice || choice === 'C'){
                // user cancelled: restore previous video/file state and revoke newly-created blob
                try{ video.pause(); }catch(e){}
                try{ if(prevVideoSrc){ video.src = prevVideoSrc; } else { video.removeAttribute && video.removeAttribute('src'); } }catch(e){}
                try{ if(typeof video.load === 'function') video.load(); }catch(e){}
                try{ if(videoFile) videoFile.value = ''; }catch(e){}
                try{ if(videoFileDisplay) videoFileDisplay.textContent = prevDisplayText; }catch(e){}
                try{ if(video && video.dataset) video.dataset.filename = prevDatasetFilename; }catch(e){}
                try{ URL.revokeObjectURL(blobUrl); }catch(e){}
                return;
            }
            // Export & clear: download current annotations then clear and load new file
            if(choice === 'E'){
              try{
                const out = buildOutput();
                download(JSON.stringify(out, null, 2), `${out.session_id || 'session'}.json`, 'application/json');
              }catch(e){ console.error('export before clear failed', e); }
              // fallthrough to clearing
            }
            // Clear (either chosen explicitly or after export): wipe annotations and proceed to load new file
            if(choice === 'L' || choice === 'E'){
              try{ stateTimeline = []; }catch(e){}
              try{ eventTimeline = []; }catch(e){}
              try{ activeEvents = {}; }catch(e){}
              try{ subjectInTime = null; }catch(e){}
              try{ manualFlags = []; }catch(e){}
              // clear testing/session metadata fields
              try{ if(document.getElementById('scorer')) document.getElementById('scorer').value = ''; }catch(e){}
              try{ if(document.getElementById('subjectId')) document.getElementById('subjectId').value = ''; }catch(e){}
              try{ if(document.getElementById('date')) document.getElementById('date').value = ''; }catch(e){}
              try{ if(document.getElementById('time')) document.getElementById('time').value = ''; }catch(e){}
              try{ renderStateList(); renderEventList(); renderSubjectIn(); saveAutosave(); }catch(e){}
              // proceed to load the newly-selected file
              handleFileAccepted();
            }
          });
      } else {
        handleFileAccepted();
      }
    }catch(e){ handleFileAccepted(); }
  });

  // Do NOT auto-fill duration from video; default is provided in the form (600s)

  // Mark subject in / clear
  if(markInBtn){ markInBtn.addEventListener('click', ()=>{
    // protect against accidental overwrite of existing annotations
    if((stateTimeline && stateTimeline.length>0) || (eventTimeline && eventTimeline.length>0)){
      const ok = confirm('There are existing annotations. Marking subject start will reset timelines and remove existing entries. Continue?');
      if(!ok) return;
    }
    subjectInTime = +seconds().toFixed(33);
    try{
      const startState = (startStateSel && startStateSel.value) ? startStateSel.value : (stateTypes && stateTypes.length>0? stateTypes[0] : 'EDGE');
      const entry = {start: subjectInTime, state: startState};
      try{ const descs = additionalForState[startState] || []; descs.forEach(d=>{ if(d.type === 'checkbox') entry[d.field] = false; else entry[d.field] = ''; }); }catch(e){}
      stateTimeline = [entry];
    }catch(e){ stateTimeline = [{start: subjectInTime, state: 'EDGE'}]; }
    renderSubjectIn(); renderStateList();
    saveAutosave();
  }); }
  if(clearInBtn){ clearInBtn.addEventListener('click', ()=>{
    // If there are existing annotations, confirm before clearing
    if((stateTimeline && stateTimeline.length>0) || (eventTimeline && eventTimeline.length>0)){
      const ok = confirm('There are existing annotations. Clearing subject start will reset timelines and remove existing entries. Continue?');
      if(!ok) return;
    }
    subjectInTime = null;
    // clear state timeline because timeline must begin at subject placement
    stateTimeline = [];
    renderSubjectIn(); renderStateList();
    saveAutosave();
  }); }

  if(setStartStateBtn){
    setStartStateBtn.addEventListener('click', ()=>{
      const s = startStateSel.value;
      const entry = {start:0, state: s};
      try{ const descs = additionalForState[s] || []; descs.forEach(d=>{ if(d.type === 'checkbox') entry[d.field] = false; else entry[d.field] = ''; }); }catch(e){}
      stateTimeline = [entry];
      renderStateList();
      saveAutosave();
    });
  }

  // playback speed control
  if(changeSpeed){
    changeSpeed.addEventListener('input', ()=>{
      const v = parseFloat(changeSpeed.value) || 1.0;
      video.playbackRate = v;
      // do not persist transient playback preferences as part of autosave
    });
  }

  // +/- buttons
  function setSpeedVal(v){
    const min = parseFloat(changeSpeed.min) || 0.25;
    const max = parseFloat(changeSpeed.max) || 4.0;
    const step = parseFloat(changeSpeed.step) || 0.25;
    let nv = Math.min(max, Math.max(min, Math.round(v/step)*step));
    changeSpeed.value = nv.toFixed(2).replace(/\.00$/, '');
    video.playbackRate = nv;
  }
  if(speedInc){ speedInc.addEventListener('click', ()=>{ setSpeedVal((parseFloat(changeSpeed.value)||1.0) + (parseFloat(changeSpeed.step)||0.25)); }); }
  if(speedDec){ speedDec.addEventListener('click', ()=>{ setSpeedVal((parseFloat(changeSpeed.value)||1.0) - (parseFloat(changeSpeed.step)||0.25)); }); }

  // keyboard shortcuts for speed control
  document.addEventListener('keydown', (e)=>{
    // don't interfere when typing in inputs
    const ae = document.activeElement && document.activeElement.tagName;
    if(ae === 'INPUT' || ae === 'TEXTAREA' || ae === 'SELECT') return;
    const step = parseFloat(changeSpeed.step) || 0.25;
    // Left/Right: step through video by stepSize (hold Shift for 1s jump)
    if(e.key === 'ArrowLeft'){
      const stepSec = parseFloat(stepInput && stepInput.value) || 0.033;
      const delta = e.shiftKey ? 1.0 : stepSec;
      video.currentTime = Math.max(0, (video.currentTime || 0) - delta);
      e.preventDefault();
    }
    if(e.key === 'ArrowRight'){
      const stepSec = parseFloat(stepInput && stepInput.value) || 0.033;
      const delta = e.shiftKey ? 1.0 : stepSec;
      video.currentTime = Math.min((video.duration||Infinity), (video.currentTime || 0) + delta);
      e.preventDefault();
    }
    
    // alternate speed keys requested: u/i/j/k
    if(e.key === 'u'){ setSpeedVal(0.5); }
    if(e.key === 'i'){ setSpeedVal(1.0); }
    if(e.key === 'j'){ setSpeedVal(2.0); }
    if(e.key === 'k'){ setSpeedVal(3.0); }

    // frame stepping (up/down)
    // Up/Down: adjust playback speed by step value
    if(e.key === 'ArrowUp'){
      setSpeedVal((parseFloat(changeSpeed.value)||1.0) + (parseFloat(changeSpeed.step)||0.25));
      e.preventDefault();
    }
    if(e.key === 'ArrowDown'){
      setSpeedVal((parseFloat(changeSpeed.value)||1.0) - (parseFloat(changeSpeed.step)||0.25));
      e.preventDefault();
    }

    // seek and playback
    if(e.key === 'z'){ // back 10s
      video.currentTime = Math.max(0, (video.currentTime || 0) - 10);
      e.preventDefault();
    }
    if(e.key === 'c'){ // forward 10s
      video.currentTime = Math.min((video.duration||Infinity), (video.currentTime || 0) + 10);
      e.preventDefault();
    }
    if(e.key === 'x' || e.key === 'm'){ // play/pause toggle
      if(video.paused) video.play(); else video.pause();
      e.preventDefault();
    }
    // mark subject in
    if(e.key && e.key.toLowerCase() === 'p'){
      if(markInBtn) markInBtn.click();
      e.preventDefault();
    }
    // go back to last marked state transition
    if(e.key && e.key.toLowerCase() === 'b'){
      const now = (video.currentTime || 0);
      try{
        const starts = stateTimeline.map(s=>s.start).filter(t=>typeof t === 'number' && t < now - 0.001).sort((a,b)=>a-b);
        let target = null;
        if(starts.length>0) target = starts[starts.length-1];
        else if(subjectInTime !== null) target = subjectInTime;
        if(target !== null){ video.currentTime = Math.max(0, target); video.pause(); }
        else { alert('No previous state transition available'); }
      }catch(e){ console.error('seek to last state error', e); }
      e.preventDefault();
    }

    // events: toggle by configured keys
    try{
      if(eventTypes && eventTypes.length){
        const pressed = (e.key || '').toLowerCase();
        for(let ii=0; ii<eventTypes.length; ii++){
          const ev = eventTypes[ii];
          const key = (typeof ev === 'string') ? null : (ev.key || null);
          const name = (typeof ev === 'string') ? ev : (ev.name || ev.event || '');
          if(key && key.toLowerCase() === pressed){ toggleEventByName(name); e.preventDefault(); break; }
        }
      }
    }catch(err){}

    // state keys: if configured in YAML, start chosen state on keypress
    try{
      const pressed = (e.key || '').toLowerCase();
      let matchedState = null;
      Object.keys(stateKeyMap || {}).forEach(st=>{ if(stateKeyMap[st] && stateKeyMap[st].toLowerCase() === pressed) matchedState = st; });
      if(matchedState){
        // insert a transition to matchedState at current time
        try{ insertStateAt(seconds(), matchedState); e.preventDefault(); }
        catch(e){}
      } else {
        // legacy single-key behavior: 'v' to add/cycle state
        if(e.key === 'v'){ if(addStateBtn && !addStateBtn.classList.contains('d-none')) addStateBtn.click(); }
      }
    }catch(e){}
  });

  // helper: toggle named event start/stop
  function toggleEventByName(evName){
    if(!evName) return;
    if(activeEvents[evName]){
      // stop (validate times similar to stopEventBtn)
      const s = activeEvents[evName];
      const e = +seconds().toFixed(3);
      if(!isWithinSession(e)){ alert('Event end must be at or before session end and after subject placement.'); return; }
      if(e <= s + 1e-6){ alert('End time must be greater than start time'); return; }
      if(!isWithinSession(s)){ alert('Event start was outside the session; not saving.'); delete activeEvents[evName]; renderEventList(); return; }
      eventTimeline.push({start: s, end: e, event: evName});
      delete activeEvents[evName];
      renderEventList(); saveAutosave();
    } else {
      // start (validate like startEventBtn)
      const now = +seconds().toFixed(3);
      if(!isWithinSession(now)){ alert('Event start must be at or after subject placement and before session end.'); return; }
      activeEvents[evName] = now;
      renderEventList(); saveAutosave();
    }
  }

  addStateBtn.addEventListener('click', ()=>{
    if(subjectInTime === null){ alert('Please mark subject start time before adding state transitions.'); return; }
    const t = +seconds().toFixed(3);
    // prevent adding transitions before subject placement
    if(t < subjectInTime){ alert('State transitions must occur at or after subject placement time.'); return; }
    // determine insertion index by time
    let insertIdx = stateTimeline.findIndex(s=> (typeof s.start==='number' && s.start > t));
    if(insertIdx === -1) insertIdx = stateTimeline.length;
    // determine prev state at this time
    const prevState = (insertIdx>0 && stateTimeline[insertIdx-1])? stateTimeline[insertIdx-1].state : (stateTimeline.length>0? stateTimeline[0].state : (stateTypes && stateTypes.length>0? stateTypes[0] : 'EDGE'));
    const nextStateVal = (insertIdx < stateTimeline.length && stateTimeline[insertIdx])? stateTimeline[insertIdx].state : null;
    let newState = null;
    if(stateTypes && Array.isArray(stateTypes) && stateTypes.length>0){
      const curIdx = Math.max(0, stateTypes.indexOf(prevState));
      newState = stateTypes[(curIdx + 1) % stateTypes.length];
    } else {
      newState = prevState === 'EDGE' ? 'CENTER' : 'EDGE';
    }
    // validate within session end
    const end = sessionEnd();
    if(t > end + 1e-6){ alert('New time is after configured session end; adjust duration or choose a different time.'); return; }
    // For multi-state tasks (3+ states) prevent creating consecutive identical states.
    if(stateTypes && stateTypes.length >= 3){
      const nextStateVal = (insertIdx < stateTimeline.length && stateTimeline[insertIdx])? stateTimeline[insertIdx].state : null;
      if((insertIdx>0 && stateTimeline[insertIdx-1] && stateTimeline[insertIdx-1].state === newState) || (nextStateVal && nextStateVal === newState)){
        try{ video.pause(); }catch(e){}
        alert('Cannot add state: would create two identical consecutive states. Choose a different time or state.');
        return;
      }
    }
    // insert (initialize any additional fields for this state)
    const newEntry = {start: +t.toFixed(3), state: newState};
    try{ const descs = additionalForState[newState] || []; descs.forEach(d=>{ if(d.type === 'checkbox') newEntry[d.field] = false; else newEntry[d.field] = ''; }); }catch(e){}
    stateTimeline.splice(insertIdx, 0, newEntry);
    // check for duplicate adjacent states
    const conflictPrev = (insertIdx>0 && stateTimeline[insertIdx-1] && stateTimeline[insertIdx-1].state === newState);
    const conflictNext = (insertIdx+1 < stateTimeline.length && stateTimeline[insertIdx+1] && stateTimeline[insertIdx+1].state === newState);
    // For multi-state tasks (3+ states) we allow additions without invoking
    // the full conflict modal; only for 2-state tasks do we present conflict resolution.
    if(conflictPrev || conflictNext){
      if(!(stateTypes && stateTypes.length >= 3)){
        handleConflict(insertIdx);
      }
    }
    renderStateList(); saveAutosave();
  });

  // helper to insert a state at time t with explicit state name
  function insertStateAt(t, desiredState){
    if(subjectInTime === null){ alert('Please mark subject start time before adding state transitions.'); return; }
    const time = +t.toFixed(3);
    if(time < subjectInTime){ alert('State transitions must occur at or after subject placement time.'); return; }
    let insertIdx = stateTimeline.findIndex(s=> (typeof s.start==='number' && s.start > time));
    if(insertIdx === -1) insertIdx = stateTimeline.length;
    // validate within session end
    const end = sessionEnd();
    if(time > end + 1e-6){ alert('New time is after configured session end; adjust duration or choose a different time.'); return; }
    // For multi-state tasks (3+ states) prevent creating consecutive identical states.
    if(stateTypes && stateTypes.length >= 3){
      const nextState = (insertIdx < stateTimeline.length && stateTimeline[insertIdx])? stateTimeline[insertIdx].state : null;
      if((insertIdx>0 && stateTimeline[insertIdx-1] && stateTimeline[insertIdx-1].state === desiredState) || (nextState && nextState === desiredState)){
        try{ video.pause(); }catch(e){}
        alert('Cannot add state: would create two identical consecutive states. Choose a different time or state.');
        return;
      }
    }
    const newEntry = {start: +time.toFixed(3), state: desiredState};
    try{ const descs = additionalForState[desiredState] || []; descs.forEach(d=>{ if(d.type === 'checkbox') newEntry[d.field] = false; else newEntry[d.field] = ''; }); }catch(e){}
    stateTimeline.splice(insertIdx, 0, newEntry);
    const conflictPrev = (insertIdx>0 && stateTimeline[insertIdx-1] && stateTimeline[insertIdx-1].state === desiredState);
    const conflictNext = (insertIdx+1 < stateTimeline.length && stateTimeline[insertIdx+1] && stateTimeline[insertIdx+1].state === desiredState);
    // For multi-state tasks (3+ states) allow insertion without complex conflict flow.
    if(conflictPrev || conflictNext){
      if(!(stateTypes && stateTypes.length >= 3)){
        handleConflict(insertIdx);
      }
    }
    renderStateList(); saveAutosave();
  }

  if(setStateBtn){ setStateBtn.addEventListener('click', ()=>{
    try{
      const s = addStateSelect && addStateSelect.value ? addStateSelect.value : null;
      if(!s){ alert('Select a state to start'); return; }
      insertStateAt(seconds(), s);
    }catch(e){ console.error('setStateBtn error', e); }
  }); }

  startEventBtn.addEventListener('click', ()=>{
    const ev = eventTypeSel.value;
    if(activeEvents[ev]){ alert('Event already active'); return; }
    const now = +seconds().toFixed(3);
    if(!isWithinSession(now)){ alert('Event start must be at or after subject placement and before session end.'); return; }
    activeEvents[ev] = now;
    renderEventList();
    saveAutosave();
  });

  stopEventBtn.addEventListener('click', ()=>{
    const ev = eventTypeSel.value;
    const s = activeEvents[ev];
    if(!s){ alert('No active event to stop'); return; }
    const e = +seconds().toFixed(3);
    if(!isWithinSession(e)){ alert('Event end must be at or before session end and after subject placement.'); return; }
    if(e <= s + 1e-6){ alert('End time must be greater than start time'); return; }
    if(!isWithinSession(s)){ alert('Event start was outside the session; not saving.'); delete activeEvents[ev]; renderEventList(); return; }
    eventTimeline.push({start: s, end: e, event: ev});
    delete activeEvents[ev];
    renderEventList();
    saveAutosave();
  });

  function renderStateList(){
    if(!stateTableBody) return;
    // ensure header contains any configured additional columns
    try{
      const theadRow = document.querySelector('#stateTable thead tr');
      if(theadRow){
        // build ordered unique list of additional fields across all states
        const allExtra = [];
        const seen = new Set();
        Object.keys(additionalForState || {}).forEach(st=>{
          const arr = additionalForState[st] || [];
          arr.forEach(desc=>{
            if(!seen.has(desc.field)){
              seen.add(desc.field);
              allExtra.push(desc);
            }
          });
        });
        // insert headers for each extra descriptor before Duration column
        allExtra.forEach((desc, idx)=>{
          const label = desc.label || desc.field;
          const present = Array.from(theadRow.children).some(th=> th.dataset && th.dataset.extraField === desc.field);
          if(!present){ const th = document.createElement('th'); th.textContent = label; th.dataset.extraField = desc.field; if(theadRow.children.length >= 4) theadRow.insertBefore(th, theadRow.children[3 + idx]); else theadRow.appendChild(th); }
        });
      }
    }catch(e){}
    stateTableBody.innerHTML = '';
    // compute session duration end time (subjectInTime + duration)
    let dur = null;
    if(videoDurInput && videoDurInput.value){ const p = parseFloat(videoDurInput.value); if(!Number.isNaN(p)) dur = p; }
    // Render most-recent states first so new entries appear near the video (top of table)
    for(let i = stateTimeline.length - 1; i >= 0; i--){
      const a = stateTimeline[i];
      // mark complementary rows visually
      const isComplement = a && a.manual_flag === 'complementary';
      const b = stateTimeline[i+1];
      const tr = document.createElement('tr');
      if(isComplement){ tr.className = 'table-warning'; }
      const tdState = document.createElement('td'); tdState.textContent = a.state;
      const tdAt = document.createElement('td'); tdAt.textContent = (typeof a.start === 'number')? a.start.toFixed(3) : '—';
      const tdStamp = document.createElement('td');
      const link = document.createElement('a'); link.href = '#'; link.textContent = formatTimeSec(a.start);
      link.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ video.currentTime = a.start; video.pause(); }catch(e){} });
      tdStamp.appendChild(link);
      // additional fields per-state (render cells for the union of configured extra fields)
      const allExtraFields = [];
      const seenFields = new Set();
      Object.keys(additionalForState || {}).forEach(st=>{
        (additionalForState[st]||[]).forEach(d=>{ if(!seenFields.has(d.field)){ seenFields.add(d.field); allExtraFields.push(d); } });
      });
      const extraTds = [];
      allExtraFields.forEach(desc=>{
        const tdExtra = document.createElement('td');
        // if this row's state has a matching descriptor, render interactive control
        const descriptorsForState = additionalForState[a.state] || [];
        const match = descriptorsForState.find(dd=> dd.field === desc.field);
        if(match){
          if(match.type === 'checkbox'){
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'form-check-input'; cb.checked = !!a[match.field];
            cb.addEventListener('change', ()=>{ try{ stateTimeline[i][match.field] = !!cb.checked; saveAutosave(); }catch(e){} });
            tdExtra.appendChild(cb);
          } else {
            tdExtra.textContent = a[match.field] !== undefined ? String(a[match.field]) : '—';
          }
        } else {
          tdExtra.textContent = '—';
        }
        extraTds.push(tdExtra);
      });
      const tdDur = document.createElement('td');
      let durVal = null;
      if(b && typeof b.start === 'number') durVal = b.start - a.start;
      else if(dur !== null && subjectInTime !== null) durVal = (subjectInTime + dur) - a.start;
      tdDur.textContent = (durVal !== null && !Number.isNaN(durVal))? durVal.toFixed(3) : '—';
      const tdAct = document.createElement('td');
      const edit = document.createElement('button'); edit.className = 'btn btn-sm btn-outline-secondary me-1'; edit.textContent='Edit';
      const isInitialPlacement = (subjectInTime != null && Math.abs((a.start||0) - subjectInTime) < 1e-6);
      edit.addEventListener('click', ()=>{
        // Inline edit: replace timestamp cell with an input and Save/Cancel buttons
        try{
          // prevent multiple editors
          if(tdStamp.querySelector('input')) return;
          const current = (typeof a.start === 'number')? formatTimeSec(a.start) : '';
          tdStamp.innerHTML = '';
          const input = document.createElement('input');
          input.type = 'text'; input.placeholder = 'MM:SS.ms or SS.ms'; input.value = current;
          input.className = 'form-control form-control-sm';
          input.style.width = '160px';
          tdStamp.appendChild(input);

          // modify action buttons to show Save / Cancel
          tdAct.innerHTML = '';
          const saveBtn = document.createElement('button'); saveBtn.className = 'btn btn-sm btn-primary me-1'; saveBtn.textContent = 'Save';
          const currentBtn = document.createElement('button'); currentBtn.className = 'btn btn-sm btn-outline-primary me-1'; currentBtn.textContent = 'Now';
          const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-sm btn-secondary'; cancelBtn.textContent = 'Cancel';
          tdAct.appendChild(currentBtn); tdAct.appendChild(saveBtn); tdAct.appendChild(cancelBtn);

          const finish = ()=>{ renderStateList(); };

          const wasInitial = isInitialPlacement;
          saveBtn.addEventListener('click', ()=>{
            const val = parseTimeToSec(input.value);
            if(Number.isNaN(val)){ alert('Invalid timestamp format; use MM:SS.ms or seconds'); return; }
            // bounds: previous start (or subjectInTime or 0) <= val < next start (or session end or Infinity)
            const prev = (i>0 && typeof stateTimeline[i-1].start === 'number') ? stateTimeline[i-1].start : (subjectInTime!==null? subjectInTime : 0);
            let nextBound = null;
            if(stateTimeline[i+1] && typeof stateTimeline[i+1].start === 'number') nextBound = stateTimeline[i+1].start;
            else if(videoDurInput && videoDurInput.value && subjectInTime !== null){ const pd = parseFloat(videoDurInput.value); if(!Number.isNaN(pd)) nextBound = subjectInTime + pd; }
            if(val < prev - 1e-6){ alert(`New time must be >= ${prev.toFixed(3)} s`); return; }
            if(nextBound !== null && val >= nextBound - 1e-6){ alert(`New time must be < ${nextBound.toFixed(3)} s`); return; }
            stateTimeline[i].start = +val.toFixed(3);
            if(wasInitial){ subjectInTime = stateTimeline[i].start; renderSubjectIn(); }
            // keep timeline ordered
            stateTimeline.sort((x,y)=> x.start - y.start);
            // find new index of edited entry
            const editedStart = +val.toFixed(3);
            let newIdx = stateTimeline.findIndex(s=> (typeof s.start==='number' && Math.abs(s.start - editedStart) < 1e-6 && s.state === a.state));
            if(newIdx === -1){ newIdx = stateTimeline.findIndex(s=> (typeof s.start==='number' && Math.abs(s.start - editedStart) < 1e-6)); }
            saveAutosave();
            if(newIdx !== -1){
              // If this edited entry was previously marked as a complementary manual insert,
              // clear the flag and remove its record from manualFlags now that user edited it.
              try{
                if(stateTimeline[newIdx] && stateTimeline[newIdx].manual_flag === 'complementary'){
                  delete stateTimeline[newIdx].manual_flag;
                  manualFlags = manualFlags.filter(f=> !(f.type === 'complementary' && typeof f.at_s === 'number' && Math.abs(f.at_s - stateTimeline[newIdx].start) < 1e-6));
                }
              }catch(e){}
              const conflictPrev = (newIdx>0 && stateTimeline[newIdx-1] && stateTimeline[newIdx-1].state === stateTimeline[newIdx].state);
              const conflictNext = (newIdx+1 < stateTimeline.length && stateTimeline[newIdx+1] && stateTimeline[newIdx+1].state === stateTimeline[newIdx].state);
              if(conflictPrev || conflictNext){ handleConflict(newIdx); return; }
            }
            finish();
          });

          currentBtn.addEventListener('click', ()=>{
            try{ input.value = formatTimeSec(seconds()); input.focus(); input.select(); }catch(e){}
          });

          cancelBtn.addEventListener('click', ()=>{ finish(); });

          // focus input
          input.focus(); input.select();
        }catch(err){ console.error('edit handler error', err); }
      });
      if(isInitialPlacement){
        const lock = document.createElement('span'); lock.className = 'badge bg-secondary'; lock.textContent = 'Locked';
        tdAct.appendChild(edit); tdAct.appendChild(lock);
      } else {
        const del = document.createElement('button'); del.className = 'btn btn-sm btn-outline-danger'; del.textContent='Delete';
        del.addEventListener('click', ()=>{
          const idx = i;
          // if last entry, allow quick single deletion
          if(idx === stateTimeline.length - 1){
            if(confirm('Delete this last state entry?')){
              stateTimeline.splice(idx,1);
              renderStateList(); saveAutosave();
            }
            return;
          }
          // For multi-state tasks (3+ states) use a simple confirm for deletions.
          if(stateTypes && stateTypes.length >= 3){
            if(confirm(`Delete state at ${formatTimeSec(stateTimeline[idx].start)}?`)){
              // check whether deleting this entry would create two identical consecutive states
              const prev = (idx>0)? stateTimeline[idx-1]: null;
              const next = (idx+1 < stateTimeline.length)? stateTimeline[idx+1]: null;
              if(prev && next && prev.state === next.state){
                // ask user whether to delete all future entries or cancel
                const msg = `Deleting this entry would make ${prev.state} occur twice in a row. Delete all future entries from here or cancel?`;
                const choices = [ {key:'A', label: 'Delete all future entries (from here)'} ];
                showConflictModal(msg, choices, (choice)=>{
                  if(!choice) return; // cancelled
                  if(choice === 'A'){
                    stateTimeline.splice(idx);
                    renderStateList(); saveAutosave();
                  }
                });
              } else {
                stateTimeline.splice(idx,1);
                renderStateList(); saveAutosave();
              }
            }
          } else {
            // intermediary entry: prompt user with options
            const msg = `Delete state at ${formatTimeSec(stateTimeline[idx].start)} — choose action:`;
            const choices = [
              {key:'D', label: 'Delete selected + next'},
              {key:'S', label: 'Delete selected + swap future'},
              {key:'A', label: 'Delete all future entries (from here)'}
            ];
            showConflictModal(msg, choices, (choice)=>{
              if(!choice) return;
              if(choice === 'D'){
                // remove this and the immediate next
                stateTimeline.splice(idx, Math.min(2, stateTimeline.length - idx));
              } else if(choice === 'A'){
                // remove this and all following entries
                stateTimeline.splice(idx);
              } else if(choice === 'S'){
                // remove only the selected entry, then advance all remaining future states in sequence
                stateTimeline.splice(idx, 1);
                if(stateTypes && Array.isArray(stateTypes) && stateTypes.length>0){
                  for(let j = idx; j < stateTimeline.length; j++){
                    const s = stateTimeline[j];
                    if(s && typeof s.state === 'string'){
                      const cur = stateTypes.indexOf(s.state);
                      s.state = stateTypes[(cur + 1) % stateTypes.length];
                    }
                  }
                } else {
                  for(let j = idx; j < stateTimeline.length; j++){
                    const s = stateTimeline[j];
                    if(s && typeof s.state === 'string') s.state = (s.state === 'EDGE' ? 'CENTER' : 'EDGE');
                  }
                }
              }
              renderStateList(); saveAutosave();
            });
          }
        });
        tdAct.appendChild(edit); tdAct.appendChild(del);
      }
      tr.appendChild(tdState); tr.appendChild(tdAt); tr.appendChild(tdStamp);
      extraTds.forEach(td=> tr.appendChild(td));
      tr.appendChild(tdDur); tr.appendChild(tdAct);
      stateTableBody.appendChild(tr);
    }
    // update current state display whenever timeline re-renders
    try{ updateCurrentStateDisplay(); }catch(e){}
  }

  function ensureEventTables(){
    if(!eventTablesContainer) return;
    // determine eventTypes if not yet set: prefer config-driven, else use select options
    if(!eventTypes){
      if(eventTypeSel && eventTypeSel.options && eventTypeSel.options.length>0){
        eventTypes = Array.from(eventTypeSel.options).map(o=>({name: o.textContent.trim(), key: (o.dataset && o.dataset.key)? o.dataset.key : null}));
      } else {
        eventTypes = [{name:'GROOMING', key:'g'}, {name:'REARING', key:'r'}];
      }
    }
    // clear container and build table per event type
    eventTablesContainer.innerHTML = '';
    for(const k in eventTableBodies) delete eventTableBodies[k];
    eventTypes.forEach(evObj=>{
      const evName = (typeof evObj === 'string') ? evObj : (evObj.name || (evObj.event || ''));
      const safe = evName.replace(/[^a-z0-9]/ig,'_');
      const tbl = document.createElement('table'); tbl.className = 'table table-sm mb-3';
      const thead = document.createElement('thead'); thead.innerHTML = `<tr><th>Event</th><th>Start (s)</th><th>Start stamp</th><th>End (s)</th><th>End stamp</th><th>Duration (s)</th><th></th></tr>`;
      const tbody = document.createElement('tbody'); tbody.id = `eventTableBody_${safe}`;
      tbl.appendChild(thead); tbl.appendChild(tbody);
      const h = document.createElement('h3'); h.textContent = `${evName} Events`;
      eventTablesContainer.appendChild(h); eventTablesContainer.appendChild(tbl);
      eventTableBodies[evName] = tbody;
    });
    try{ renderKeystrokes(); }catch(e){}
  }

  function renderKeystrokes(){
    try{
      const holder = document.getElementById('keystrokesEvents');
      const stateKeystrokeInfo = document.getElementById('stateKeystrokeInfo');
      if(!holder) return;
      // build list of mappings
      const parts = [];
      // include state key mappings if present
      // update the separate State instruction li
      try{
        if(stateKeystrokeInfo){
          if(stateKeyMap && Object.keys(stateKeyMap).length>0){
            // show configured state keys
            stateKeystrokeInfo.innerHTML = '<strong>State:</strong> ' + Object.keys(stateKeyMap).map(st=> `<kbd>${stateKeyMap[st]}</kbd> = ${st}`).join(', ');
          } else if(stateTypes && stateTypes.length >= 3){
            stateKeystrokeInfo.innerHTML = '<strong>State:</strong> use the dropdown and Start button to begin a state';
          } else {
            stateKeystrokeInfo.innerHTML = '<strong>State:</strong> <kbd>v</kbd> = add state transition (switch state)';
          }
        }
      }catch(e){}
      // State keystrokes are shown in the separate `stateKeystrokeInfo` element above;
      // do not duplicate them in the events list (parts).
      if(eventTypes && eventTypes.length>0){
        eventTypes.forEach(ev=>{
          const name = (typeof ev==='string')? ev : (ev.name || ev.event);
          const key = (typeof ev==='string')? null : (ev.key || null);
          if(key){
            const k = document.createElement('kbd'); k.textContent = key;
            const span = document.createElement('span'); span.className = 'ms-1 me-2'; span.appendChild(k); span.appendChild(document.createTextNode(` = start/stop ${name}`));
            parts.push(span);
          } else {
            parts.push(document.createTextNode(`${name}`));
          }
        });
      }
      holder.innerHTML = '';
      const strong = document.createElement('strong'); strong.textContent = 'Events:';
      holder.appendChild(strong);
      const wrap = document.createElement('span'); wrap.className = 'ms-1';
      parts.forEach(p=> wrap.appendChild(p));
      holder.appendChild(wrap);
    }catch(e){}
  }

  function renderDefinitions(cfg){
    try{
      if(!definitionsBody) return;
      definitionsBody.innerHTML = '';
      if(!cfg || typeof cfg.definitions === 'undefined' || cfg.definitions === null) return;
      const defs = cfg.definitions;
      const rows = [];
      if(Array.isArray(defs)){
        defs.forEach((d,i)=>{
          if(typeof d === 'string'){
            rows.push({term: (i+1).toString(), text: d});
          } else if(d && typeof d === 'object'){
            // array entry is a mapping: show each key: value pair
            Object.keys(d).forEach(k=>{
              const v = d[k];
              rows.push({term: k, text: (typeof v === 'string') ? v : JSON.stringify(v)});
            });
          } else {
            rows.push({term: (i+1).toString(), text: String(d)});
          }
        });
      } else if(defs && typeof defs === 'object'){
        Object.keys(defs).forEach((k,i)=>{
          const v = defs[k];
          rows.push({term: k, text: (typeof v === 'string') ? v : JSON.stringify(v)});
        });
      } else {
        rows.push({term: '1', text: String(defs)});
      }
      rows.forEach(r=>{
        const tr = document.createElement('tr');
        const th = document.createElement('th'); th.scope = 'row'; th.textContent = r.term;
        const td = document.createElement('td'); td.textContent = r.text;
        tr.appendChild(th); tr.appendChild(td);
        definitionsBody.appendChild(tr);
      });
    }catch(e){/* ignore render errors */}
  }

  function renderEventList(){
    if(!eventTablesContainer) return;
    // ensure tables exist
    ensureEventTables();
    // prepare mapping for finished events by type
    const finishedByType = {};
    eventTimeline.forEach((e, idx)=>{
      if(!finishedByType[e.event]) finishedByType[e.event] = [];
      finishedByType[e.event].push({entry: e, idx});
    });
    // clear all tbodies
    Object.keys(eventTableBodies).forEach(k=>{ const tb = eventTableBodies[k]; if(tb) tb.innerHTML = ''; });
    // render active events first under their type
    Object.keys(activeEvents).forEach(evName=>{
      const start = activeEvents[evName];
      const tbody = eventTableBodies[evName] || null;
      const tr = document.createElement('tr');
      const tdEvent = document.createElement('td'); tdEvent.textContent = evName + ' (active)';
      const tdStart = document.createElement('td'); tdStart.textContent = (typeof start==='number')? start.toFixed(3) : '—';
      const tdStamp = document.createElement('td');
      const link = document.createElement('a'); link.href = '#'; link.textContent = formatTimeSec(start);
      link.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ video.currentTime = start; video.pause(); }catch(e){} });
      tdStamp.appendChild(link);
      const tdEnd = document.createElement('td'); tdEnd.textContent = 'active';
      const tdEndStamp = document.createElement('td'); tdEndStamp.textContent = '—';
      const tdDur = document.createElement('td'); tdDur.textContent = 'active';
      const tdAct = document.createElement('td');
      const editStartBtn = document.createElement('button'); editStartBtn.className = 'btn btn-sm btn-outline-secondary me-1'; editStartBtn.textContent = 'Edit start';
      editStartBtn.addEventListener('click', ()=>{
        try{
          // prevent multiple editors
          if(tdStamp.querySelector('input')) return;
          const current = (typeof start === 'number')? formatTimeSec(start) : '';
          tdStamp.innerHTML = '';
          const input = document.createElement('input'); input.type = 'text'; input.className = 'form-control form-control-sm'; input.style.width = '140px'; input.value = current; input.placeholder = 'MM:SS.ms or SS.ms';
          tdStamp.appendChild(input);

          // replace action buttons with Now / Save / Cancel
          const origActHtml = tdAct.innerHTML;
          tdAct.innerHTML = '';
          const nowBtn = document.createElement('button'); nowBtn.className = 'btn btn-sm btn-outline-primary me-1'; nowBtn.textContent = 'Now';
          const saveBtn = document.createElement('button'); saveBtn.className = 'btn btn-sm btn-primary me-1'; saveBtn.textContent = 'Save';
          const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-sm btn-secondary'; cancelBtn.textContent = 'Cancel';
          tdAct.appendChild(nowBtn); tdAct.appendChild(saveBtn); tdAct.appendChild(cancelBtn);

          nowBtn.addEventListener('click', ()=>{ try{ input.value = formatTimeSec(seconds()); input.focus(); input.select(); }catch(e){} });
          saveBtn.addEventListener('click', ()=>{
            const val = parseTimeToSec(input.value);
            if(Number.isNaN(val)){ alert('Invalid timestamp format'); return; }
            // ensure start < now for active events
            if(val > seconds() + 1e-6){ alert('Start cannot be in the future'); return; }
            activeEvents[evName] = +val.toFixed(3);
            tdAct.innerHTML = origActHtml; renderEventList(); saveAutosave();
          });
          cancelBtn.addEventListener('click', ()=>{ tdAct.innerHTML = origActHtml; renderEventList(); });
          input.focus(); input.select();
        }catch(err){ console.error('active edit start error', err); }
      });
      const editEndBtn = document.createElement('button'); editEndBtn.className = 'btn btn-sm btn-outline-secondary me-1'; editEndBtn.textContent = 'Set end';
      editEndBtn.addEventListener('click', ()=>{
        try{
          // prevent multiple editors
          if(tdEndStamp.querySelector('input')) return;
          const suggested = formatTimeSec(seconds());
          tdEndStamp.innerHTML = '';
          const input = document.createElement('input'); input.type = 'text'; input.className = 'form-control form-control-sm'; input.style.width = '140px'; input.value = suggested; input.placeholder = 'MM:SS.ms or SS.ms';
          tdEndStamp.appendChild(input);

          const origActHtml = tdAct.innerHTML;
          tdAct.innerHTML = '';
          const nowBtn = document.createElement('button'); nowBtn.className = 'btn btn-sm btn-outline-primary me-1'; nowBtn.textContent = 'Now';
          const saveBtn = document.createElement('button'); saveBtn.className = 'btn btn-sm btn-primary me-1'; saveBtn.textContent = 'Save';
          const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-sm btn-secondary'; cancelBtn.textContent = 'Cancel';
          tdAct.appendChild(nowBtn); tdAct.appendChild(saveBtn); tdAct.appendChild(cancelBtn);

          nowBtn.addEventListener('click', ()=>{ try{ input.value = formatTimeSec(seconds()); input.focus(); input.select(); }catch(e){} });
          saveBtn.addEventListener('click', ()=>{
            const parsed = parseTimeToSec(input.value);
            if(Number.isNaN(parsed)){ alert('Invalid timestamp'); return; }
            const st = activeEvents[evName]; if(typeof st !== 'number'){ alert('No active start time'); return; }
            if(parsed <= st + 1e-6){ alert('End time must be greater than start time'); return; }
            eventTimeline.push({start: st, end: +parsed.toFixed(3), event: evName}); delete activeEvents[evName]; tdAct.innerHTML = origActHtml; renderEventList(); saveAutosave();
          });
          cancelBtn.addEventListener('click', ()=>{ tdAct.innerHTML = origActHtml; renderEventList(); });
          input.focus(); input.select();
        }catch(err){ console.error('active set end error', err); }
      });
      const stopBtn = document.createElement('button'); stopBtn.className = 'btn btn-sm btn-warning me-1'; stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', ()=>{ const e = +seconds().toFixed(3); eventTimeline.push({start: start, end: e, event: evName}); delete activeEvents[evName]; renderEventList(); saveAutosave(); });
      tdAct.appendChild(editStartBtn); tdAct.appendChild(editEndBtn); tdAct.appendChild(stopBtn);
      tr.appendChild(tdEvent); tr.appendChild(tdStart); tr.appendChild(tdStamp); tr.appendChild(tdEnd); tr.appendChild(tdEndStamp); tr.appendChild(tdDur); tr.appendChild(tdAct);
      if(tbody) tbody.appendChild(tr);
    });
    // render finished events grouped by type
    Object.keys(finishedByType).forEach(evName=>{
      const list = finishedByType[evName];
      const tbody = eventTableBodies[evName] || null;
      list.forEach(item=>{
        const e = item.entry;
        const tr = document.createElement('tr');
        const tdEvent = document.createElement('td'); tdEvent.textContent = e.event;
        const tdStart = document.createElement('td'); tdStart.textContent = (typeof e.start === 'number')? e.start.toFixed(3) : '—';
        const tdStamp = document.createElement('td');
        const link = document.createElement('a'); link.href='#'; link.textContent = formatTimeSec(e.start);
        link.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ video.currentTime = e.start; video.pause(); }catch(err){} });
        tdStamp.appendChild(link);
        const tdEnd = document.createElement('td'); tdEnd.textContent = (typeof e.end === 'number')? e.end.toFixed(3) : '—';
        const tdEndStamp = document.createElement('td');
        if(typeof e.end === 'number'){
          const endLink = document.createElement('a'); endLink.href = '#'; endLink.textContent = formatTimeSec(e.end);
          endLink.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ video.currentTime = e.end; video.pause(); }catch(err){} });
          tdEndStamp.appendChild(endLink);
        } else { tdEndStamp.textContent = '—'; }
        const tdDur = document.createElement('td'); tdDur.textContent = ((typeof e.end==='number' && typeof e.start==='number')? (e.end - e.start).toFixed(3) : '—');
        const tdAct = document.createElement('td');
        const editStartBtn = document.createElement('button'); editStartBtn.className = 'btn btn-sm btn-outline-secondary me-1'; editStartBtn.textContent = 'Edit start';
        editStartBtn.addEventListener('click', ()=>{
          try{
            if(tdStamp.querySelector('input')) return;
            const current = (typeof e.start === 'number')? formatTimeSec(e.start) : '';
            tdStamp.innerHTML = '';
            const input = document.createElement('input'); input.type = 'text'; input.className = 'form-control form-control-sm'; input.style.width = '140px'; input.value = current; input.placeholder = 'MM:SS.ms or SS.ms';
            tdStamp.appendChild(input);
            const origActHtml = tdAct.innerHTML; tdAct.innerHTML = '';
            const nowBtn = document.createElement('button'); nowBtn.className = 'btn btn-sm btn-outline-primary me-1'; nowBtn.textContent = 'Now';
            const saveBtn = document.createElement('button'); saveBtn.className = 'btn btn-sm btn-primary me-1'; saveBtn.textContent = 'Save';
            const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-sm btn-secondary'; cancelBtn.textContent = 'Cancel';
            tdAct.appendChild(nowBtn); tdAct.appendChild(saveBtn); tdAct.appendChild(cancelBtn);
            nowBtn.addEventListener('click', ()=>{ try{ input.value = formatTimeSec(seconds()); input.focus(); input.select(); }catch(e){} });
            saveBtn.addEventListener('click', ()=>{
              const parsed = parseTimeToSec(input.value);
              if(Number.isNaN(parsed)){ alert('Invalid timestamp'); return; }
              if(typeof e.end === 'number' && parsed >= e.end - 1e-6){ alert('Start must be < end'); return; }
              e.start = +parsed.toFixed(3);
              tdAct.innerHTML = origActHtml; renderEventList(); saveAutosave();
            });
            cancelBtn.addEventListener('click', ()=>{ tdAct.innerHTML = origActHtml; renderEventList(); });
            input.focus(); input.select();
          }catch(err){ console.error('edit finished start error', err); }
        });
        const editEndBtn = document.createElement('button'); editEndBtn.className = 'btn btn-sm btn-outline-secondary me-1'; editEndBtn.textContent = 'Edit end';
        editEndBtn.addEventListener('click', ()=>{
          try{
            if(tdEndStamp.querySelector('input')) return;
            const current = (typeof e.end === 'number')? formatTimeSec(e.end) : '';
            tdEndStamp.innerHTML = '';
            const input = document.createElement('input'); input.type = 'text'; input.className = 'form-control form-control-sm'; input.style.width = '140px'; input.value = current; input.placeholder = 'MM:SS.ms or SS.ms';
            tdEndStamp.appendChild(input);
            const origActHtml = tdAct.innerHTML; tdAct.innerHTML = '';
            const nowBtn = document.createElement('button'); nowBtn.className = 'btn btn-sm btn-outline-primary me-1'; nowBtn.textContent = 'Now';
            const saveBtn = document.createElement('button'); saveBtn.className = 'btn btn-sm btn-primary me-1'; saveBtn.textContent = 'Save';
            const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-sm btn-secondary'; cancelBtn.textContent = 'Cancel';
            tdAct.appendChild(nowBtn); tdAct.appendChild(saveBtn); tdAct.appendChild(cancelBtn);
            nowBtn.addEventListener('click', ()=>{ try{ input.value = formatTimeSec(seconds()); input.focus(); input.select(); }catch(e){} });
            saveBtn.addEventListener('click', ()=>{
              const parsed = parseTimeToSec(input.value);
              if(Number.isNaN(parsed)){ alert('Invalid timestamp'); return; }
              if(parsed <= e.start + 1e-6){ alert('End must be > start'); return; }
              e.end = +parsed.toFixed(3);
              tdAct.innerHTML = origActHtml; renderEventList(); saveAutosave();
            });
            cancelBtn.addEventListener('click', ()=>{ tdAct.innerHTML = origActHtml; renderEventList(); });
            input.focus(); input.select();
          }catch(err){ console.error('edit finished end error', err); }
        });
        const del = document.createElement('button'); del.className = 'btn btn-sm btn-outline-danger'; del.textContent='Delete';
        del.addEventListener('click', ()=>{ const idx = eventTimeline.indexOf(e); if(idx!==-1) eventTimeline.splice(idx,1); renderEventList(); saveAutosave(); });
        tdAct.appendChild(editStartBtn); tdAct.appendChild(editEndBtn); tdAct.appendChild(del);
        tr.appendChild(tdEvent); tr.appendChild(tdStart); tr.appendChild(tdStamp); tr.appendChild(tdEnd); tr.appendChild(tdEndStamp); tr.appendChild(tdDur); tr.appendChild(tdAct);
        if(tbody) tbody.appendChild(tr);
      });
    });
  }

  if(exportJsonBtns && exportJsonBtns.length){
    Array.from(exportJsonBtns).forEach(btn=> btn.addEventListener('click', ()=>{
      const out = buildOutput();
      const filename = `${out.session_id || 'session'}.json`;
      download(JSON.stringify(out, null, 2), filename, 'application/json');
    }));
  }

  // Import JSON (from exported session files)
  if(importJsonFile){
    importJsonFile.addEventListener('change', (ev)=>{
      const f = ev.target.files && ev.target.files[0];
      if(!f) return;
      const reader = new FileReader();
      reader.onload = function(evt){
        try{
          const parsed = JSON.parse(evt.target.result);
          applyImportedSession(parsed);
          alert('Imported session JSON successfully.');
        }catch(e){ alert('Failed to import JSON: '+ e.message); }
      };
      reader.readAsText(f);
      // clear selection
      importJsonFile.value = '';
    });
  }

  if(exportCsvBtn){ exportCsvBtn.addEventListener('click', ()=>{
    const out = buildOutput();
    // states CSV
    const statesCsv = ['start,end,state'];
    out.state_timeline.forEach(s=> statesCsv.push(`${s.start},${s.end},${s.state}`));
    const eventsCsv = ['start,end,event'];
    out.event_timeline.forEach(e=> eventsCsv.push(`${e.start},${e.end},${e.event}`));
    const csvCombined = ['--- STATES ---'].concat(statesCsv).concat(['','--- EVENTS ---']).concat(eventsCsv).join('\n');
    download(csvCombined, `${out.session_id||'session'}.csv`, 'text/csv');
  }); }

  clearAllBtn.addEventListener('click', ()=>{
    if(!confirm('Clear all annotations? This cannot be undone.')) return;
    stateTimeline = [];
    eventTimeline = [];
    activeEvents = {};
    renderStateList(); renderEventList(); saveAutosave();
  });

  function buildOutput(){
    // prefer user-provided duration if present, otherwise default to configured default
    let duration = DEFAULT_DURATION;
    if(videoDurInput && videoDurInput.value){
      const parsed = parseFloat(videoDurInput.value);
      if(!Number.isNaN(parsed)) duration = parsed;
    }
    // compute state timeline with end times
    const states = stateTimeline.map((s,i)=>{
      const next = stateTimeline[i+1];
      const out = {start: s.start, end: next? next.start : (duration||null), state: s.state};
      // include any extra fields configured or present on the entry (exclude internal flags)
      Object.keys(s).forEach(k=>{
        if(!['start','state','manual_flag'].includes(k)) out[k] = s[k];
      });
      return out;
    });
    // compute session end if subject placed
    let session_end = null;
    if(subjectInTime !== null){ session_end = subjectInTime + duration; }
    // determine current task from selector or config basename
    let taskVal = 'open_field';
    try{ if(taskTypeSel && taskTypeSel.value) taskVal = taskTypeSel.value; else taskVal = TASK_CONFIG.split('/').pop().replace('.yaml',''); }catch(e){}
    const shortMap = { 'open_field': 'OFT', 'light_dark': 'LD', 'elevated_plus': 'EPM' };
    const shortTag = shortMap[taskVal] || taskVal.toUpperCase();
    const out = {
      session_id: `${document.getElementById('subjectId').value || 'subject'}_${shortTag}_${document.getElementById('date').value || new Date().toISOString().slice(0,10)}_${(document.getElementById('scorer') && document.getElementById('scorer').value) || 'scorer'}`,
      task: taskVal,
      duration_s: duration,
      subject: {species:'rat', id: document.getElementById('subjectId').value || ''},
      metadata: { video_file: video.dataset.filename||'', date: document.getElementById('date').value||'', time: document.getElementById('time').value||'', scorer: document.getElementById('scorer').value||'', comments: '' , subject_placed_at_s: subjectInTime, session_end_s: session_end, session_end_note: session_end !== null ? `Computed end = ${formatTimeSec(session_end)} (${session_end.toFixed(3)} s)` : '', manual_flags: manualFlags.slice()},
      state_timeline: states,
      event_timeline: eventTimeline.slice(),
      tool_version: TOOL_VERSION,
      task_config: TASK_CONFIG
    };
    return out;
  }

  function download(content, filename, type){
    const blob = new Blob([content], {type: type});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // Autosave to localStorage
  const AS_KEY = 'oft_scoring_autosave_v0';
  function saveAutosave(){
    const vidDur = (videoDurInput && videoDurInput.value) ? parseFloat(videoDurInput.value) : 600;
    // include current task selection in autosave metadata
    let currentTaskVal = null;
    try{ if(taskTypeSel && taskTypeSel.value) currentTaskVal = taskTypeSel.value; else currentTaskVal = TASK_CONFIG.split('/').pop().replace('.yaml',''); }catch(e){}
    const state = {stateTimeline, eventTimeline, activeEvents, metadata:{scorer:document.getElementById('scorer').value, subjectId:document.getElementById('subjectId').value, subject_in_time_s: subjectInTime, video_duration_s: vidDur, video_file: video.dataset.filename || (videoFile && videoFile.files && videoFile.files[0] && videoFile.files[0].name) || '', manual_flags: manualFlags.slice(), task: currentTaskVal, task_config: TASK_CONFIG}};
    try{ localStorage.setItem(AS_KEY, JSON.stringify(state)); savedAutosave = state; }catch(e){}
  }
  function loadAutosave(){
    try{ const raw = localStorage.getItem(AS_KEY); if(raw){ const s = JSON.parse(raw); savedAutosave = s; /* do not auto-apply: only offer restore when same video is loaded */ } }catch(e){}
  }

  function applyAutosave(s){
    try{
      if(s.stateTimeline) stateTimeline = s.stateTimeline.slice(); else stateTimeline = [];
      if(s.eventTimeline) eventTimeline = s.eventTimeline.slice(); else eventTimeline = [];
      if(s.activeEvents) activeEvents = Object.assign({}, s.activeEvents); else activeEvents = {};
      if(s.metadata && typeof s.metadata.subject_in_time_s !== 'undefined') subjectInTime = s.metadata.subject_in_time_s;
      if(s.metadata && typeof s.metadata.video_duration_s !== 'undefined' && s.metadata.video_duration_s !== null){ if(videoDurInput) videoDurInput.value = s.metadata.video_duration_s; }
      // restore task selection if present in autosave metadata
      try{
        const t = (s.metadata && s.metadata.task) ? s.metadata.task : (s.metadata && s.metadata.task_config ? (s.metadata.task_config.split('/').pop().replace('.yaml','')) : null);
        if(t){ TASK_CONFIG = `config/${t}.yaml`; if(taskTypeSel) taskTypeSel.value = t; try{ loadConfig(); }catch(e){} }
      }catch(e){}
      // restore scorer, subject id, date, time if present in autosave metadata
      try{
        if(s.metadata && typeof s.metadata.scorer !== 'undefined' && document.getElementById('scorer')) document.getElementById('scorer').value = s.metadata.scorer;
        if(s.metadata && typeof s.metadata.subjectId !== 'undefined' && document.getElementById('subjectId')) document.getElementById('subjectId').value = s.metadata.subjectId;
        if(s.metadata && typeof s.metadata.date !== 'undefined' && document.getElementById('date')) document.getElementById('date').value = s.metadata.date;
        if(s.metadata && typeof s.metadata.time !== 'undefined' && document.getElementById('time')) document.getElementById('time').value = s.metadata.time;
      }catch(e){}
      renderStateList(); renderEventList(); renderSubjectIn();
    }catch(e){ console.error('applyAutosave error', e); }
  }

  function applyImportedSession(parsed){
    // parsed may be canonical export (state_timeline/event_timeline) or older autosave shape
    try{
      // states
      if(parsed.state_timeline && Array.isArray(parsed.state_timeline)){
        // convert canonical states -> internal stateTimeline (preserve extra fields)
        stateTimeline = parsed.state_timeline.map(s=>{
          const obj = {start: s.start, state: s.state};
          Object.keys(s).forEach(k=>{ if(!['start','end','state'].includes(k)) obj[k] = s[k]; });
          return obj;
        });
      }else if(parsed.stateTimeline && Array.isArray(parsed.stateTimeline)){
        stateTimeline = parsed.stateTimeline.slice();
      }
      // events
      if(parsed.event_timeline && Array.isArray(parsed.event_timeline)){
        eventTimeline = parsed.event_timeline.map(e=>({start: e.start, end: e.end, event: e.event}));
      }else if(parsed.eventTimeline && Array.isArray(parsed.eventTimeline)){
        eventTimeline = parsed.eventTimeline.slice();
      }
      // subject placement and metadata (check multiple keys)
      if(parsed.metadata){
        if(typeof parsed.metadata.subject_placed_at_s !== 'undefined') subjectInTime = parsed.metadata.subject_placed_at_s;
        else if(typeof parsed.metadata.subject_in_time_s !== 'undefined') subjectInTime = parsed.metadata.subject_in_time_s;
        else if(typeof parsed.metadata.subject_placed_at_s !== 'undefined') subjectInTime = parsed.metadata.subject_placed_at_s;
        // duration
        if(typeof parsed.duration_s !== 'undefined'){ if(videoDurInput) videoDurInput.value = parsed.duration_s; }
        if(typeof parsed.metadata.video_duration_s !== 'undefined'){ if(videoDurInput) videoDurInput.value = parsed.metadata.video_duration_s; }
        // subject id / date / time / scorer
        try{
          if(parsed.subject && parsed.subject.id && document.getElementById('subjectId')) document.getElementById('subjectId').value = parsed.subject.id;
          if(typeof parsed.metadata.date !== 'undefined' && document.getElementById('date')) document.getElementById('date').value = parsed.metadata.date;
          if(typeof parsed.metadata.time !== 'undefined' && document.getElementById('time')) document.getElementById('time').value = parsed.metadata.time;
          if(typeof parsed.metadata.scorer !== 'undefined' && document.getElementById('scorer')) document.getElementById('scorer').value = parsed.metadata.scorer;
          if(typeof parsed.metadata.video_file !== 'undefined'){
            if(videoFileDisplay) videoFileDisplay.textContent = `File: ${parsed.metadata.video_file}`;
            // store as dataset for future exports
            video.dataset.filename = parsed.metadata.video_file || '';
          }
        }catch(e){}
      }
      // if the imported session specifies a task, switch to it (but keep annotations loaded)
      try{
        const importedTask = parsed.task || (parsed.task_config ? parsed.task_config.split('/').pop().replace('.yaml','') : (parsed.metadata && parsed.metadata.task ? parsed.metadata.task : null));
        if(importedTask){ TASK_CONFIG = `config/${importedTask}.yaml`; if(taskTypeSel) taskTypeSel.value = importedTask; try{ loadConfig(); }catch(e){} }
      }catch(e){}
      // set starting state from first state entry if available
      try{
        if(stateTimeline && stateTimeline.length>0 && startStateSel){ startStateSel.value = stateTimeline[0].state; }
      }catch(e){}
      renderStateList(); renderEventList(); renderSubjectIn();
      // update autosave backup with imported session (do not change video file)
      saveAutosave();
    }catch(e){ throw e; }
  }

  // load config (yaml) if served via http(s). If not available, ignore.
  function loadConfig(){
    // reset previous config-derived globals so switching tasks clears old options/columns
    try{ additionalForState = {}; stateTypes = []; eventTypes = null; stateKeyMap = {}; if(startStateSel) startStateSel.innerHTML = ''; if(eventTypeSel) eventTypeSel.innerHTML = ''; if(addStateSelect) addStateSelect.innerHTML = ''; }catch(e){}
    fetch(TASK_CONFIG).then(r=>{
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }).then(txt=>{
      try{
        const cfg = jsyaml.load(txt);
        // load state types from config and populate start state select
        if(cfg && cfg.states && Array.isArray(cfg.states) && cfg.states.length>0){
          stateTypes = [];
          stateKeyMap = {};
          cfg.states.forEach(item=>{
            if(typeof item === 'string'){ stateTypes.push(item); }
            else if(typeof item === 'object'){ const name = item.name || item.state || String(item); stateTypes.push(name); if(item.key) stateKeyMap[name] = item.key; }
          });
          try{
            if(startStateSel){ startStateSel.innerHTML = ''; stateTypes.forEach(s=>{ const o = document.createElement('option'); o.textContent = s; o.value = s; startStateSel.appendChild(o); }); }
          }catch(e){}
        }
        if(cfg && cfg.default_start){ try{ if(startStateSel) startStateSel.value = cfg.default_start; }catch(e){} }
        // set default duration from config if provided
        if(cfg && typeof cfg.duration !== 'undefined'){
          try{ DEFAULT_DURATION = Number(cfg.duration) || DEFAULT_DURATION; if(videoDurInput) videoDurInput.value = DEFAULT_DURATION; }catch(e){}
        }
        // additional per-state fields: prefer explicit mapping
        if(cfg && cfg.additional_for_state && typeof cfg.additional_for_state === 'object'){
          // normalize mapping: state -> array of descriptors {field,label,type}
          Object.keys(cfg.additional_for_state).forEach(st=>{
            const v = cfg.additional_for_state[st];
            if(Array.isArray(v)){
              additionalForState[st] = v.map(item => (typeof item === 'string')? {field: item, label: item, type: 'checkbox'} : { field: item.field || item.name || item.label || String(item), label: item.label || item.name || item.field || String(item), type: item.type || 'checkbox' });
            } else if(typeof v === 'object'){
              const item = v;
              const desc = { field: item.field || item.name || item.label || String(item), label: item.label || item.name || item.field || String(item), type: item.type || 'checkbox' };
              additionalForState[st] = [desc];
            } else if(typeof v === 'string'){
              additionalForState[st] = [{field: v, label: v, type: 'checkbox'}];
            }
          });
        }
        // load event types from config if provided (normalize to {name,key})
        if(cfg && cfg.events && Array.isArray(cfg.events) && cfg.events.length>0){
          eventTypes = cfg.events.map(item=>{
            if(typeof item === 'string') return {name: item, key: null};
            if(typeof item === 'object') return {name: item.name || item.event || String(item), key: item.key || item.k || null};
            return {name: String(item), key: null};
          });
          // populate eventType select if present
          try{ if(eventTypeSel){ eventTypeSel.innerHTML = ''; eventTypes.forEach(ev=>{ const o = document.createElement('option'); o.textContent = ev.name; if(ev.key) o.dataset.key = ev.key; eventTypeSel.appendChild(o); }); } }catch(e){}
          // build per-event tables now that we have types
          try{ ensureEventTables(); renderEventList(); }catch(e){}
        } else {
          // events not present in config; fall back to select/defaults
        }
        // render definitions from config (if present)
        try{ renderDefinitions(cfg); }catch(e){}
        // update state controls UI depending on number of states
        try{ updateStateControlsUI(); renderKeystrokes(); }catch(e){}
      }catch(e){
        // parsing failed; ignore and continue with defaults
      }
    }).catch(err=>{
      // failed to fetch config; ignore and continue with defaults
    });
  }

  // init
  loadAutosave();
  try{ ensureEventTables(); renderEventList(); }catch(e){}
  loadConfig();

  // initialize task selector and handle changes
  try{
    if(taskTypeSel){
      // set selector to match default TASK_CONFIG and track previous value
      try{ const basename = TASK_CONFIG.split('/').pop().replace('.yaml',''); taskTypeSel.value = basename; }catch(e){}
      let previousTaskVal = null;
      try{ previousTaskVal = (taskTypeSel && taskTypeSel.value) ? taskTypeSel.value : (TASK_CONFIG.split('/').pop().replace('.yaml','')); }catch(e){}
      taskTypeSel.addEventListener('change', ()=>{
        const newTask = taskTypeSel.value;
        // If this change was initiated automatically (filename detection), do a silent switch
        if(suppressClearOnTaskSwitch){
          suppressClearOnTaskSwitch = false;
          previousTaskVal = newTask;
          TASK_CONFIG = `config/${newTask}.yaml`;
          try{ loadConfig(); ensureEventTables(); renderEventList(); renderStateList(); saveAutosave(); }catch(e){}
          return;
        }
        // if unchanged or we have no previous value, just switch
        if(!previousTaskVal || previousTaskVal === newTask){ previousTaskVal = newTask; TASK_CONFIG = `config/${newTask}.yaml`; try{ loadConfig(); ensureEventTables(); renderEventList(); renderStateList(); }catch(e){}; return; }

        // if there are annotations, prompt user to export or clear
        const hasAnnotations = (stateTimeline && stateTimeline.length>0) || (eventTimeline && eventTimeline.length>0) || (activeEvents && Object.keys(activeEvents).length>0) || (subjectInTime !== null);
        if(hasAnnotations){
          const msg = `Changing task to ${newTask} will clear current annotations from the window. You may want to export current annotations to JSON first.`;
          const choices = [ {key:'E', label: 'Export & switch'}, {key:'S', label: 'Switch & clear'} ];
          showConflictModal(msg, choices, (choice)=>{
            if(!choice){ // cancelled -> restore previous selection
              try{ taskTypeSel.value = previousTaskVal; }catch(e){}
              return;
            }
            if(choice === 'E'){
              try{ const out = buildOutput(); const filename = `${out.session_id || 'session'}.json`; download(JSON.stringify(out, null, 2), filename, 'application/json'); }catch(e){}
            }
            // clear current annotations and form fields, then switch task
            try{
              stateTimeline = []; eventTimeline = []; activeEvents = {}; manualFlags = []; subjectInTime = null;
              try{ const el = document.getElementById('subjectId'); if(el) el.value = ''; }catch(e){}
              try{ const el = document.getElementById('scorer'); if(el) el.value = ''; }catch(e){}
              try{ const el = document.getElementById('date'); if(el) el.value = ''; }catch(e){}
              try{ const el = document.getElementById('time'); if(el) el.value = ''; }catch(e){}
              try{ if(video){ try{ video.pause(); }catch(e){} try{ video.removeAttribute('src'); }catch(e){} try{ if(typeof video.load === 'function') video.load(); }catch(e){} } }catch(e){}
              try{ if(videoFile) videoFile.value = ''; }catch(e){}
              try{ if(videoFileDisplay) videoFileDisplay.textContent = ''; }catch(e){}
              try{ if(video && video.dataset) video.dataset.filename = ''; }catch(e){}
            }catch(e){}
            TASK_CONFIG = `config/${newTask}.yaml`;
            previousTaskVal = newTask;
            try{ loadConfig(); ensureEventTables(); renderEventList(); renderStateList(); renderSubjectIn(); saveAutosave(); }catch(e){}
          });
        } else {
          // no annotations, safe to switch; clear form fields and video info per preference
          try{ const el = document.getElementById('subjectId'); if(el) el.value = ''; }catch(e){}
          try{ const el = document.getElementById('scorer'); if(el) el.value = ''; }catch(e){}
          try{ const el = document.getElementById('date'); if(el) el.value = ''; }catch(e){}
          try{ const el = document.getElementById('time'); if(el) el.value = ''; }catch(e){}
          try{ if(video){ try{ video.pause(); }catch(e){} try{ video.removeAttribute('src'); }catch(e){} try{ if(typeof video.load === 'function') video.load(); }catch(e){} } }catch(e){}
          try{ if(videoFile) videoFile.value = ''; }catch(e){}
          try{ if(videoFileDisplay) videoFileDisplay.textContent = ''; }catch(e){}
          try{ if(video && video.dataset) video.dataset.filename = ''; }catch(e){}
          TASK_CONFIG = `config/${newTask}.yaml`;
          previousTaskVal = newTask;
          try{ loadConfig(); ensureEventTables(); renderEventList(); renderStateList(); saveAutosave(); }catch(e){}
        }
      });
    }
  }catch(e){}

  // update current state as video plays/seeks
  try{ video.addEventListener('timeupdate', updateCurrentStateDisplay); }catch(e){}

  // expose for debugging (include current task)
  try{
    const currentTask = (taskTypeSel && taskTypeSel.value) ? taskTypeSel.value : (TASK_CONFIG.split('/').pop().replace('.yaml',''));
    window._oft = {stateTimeline, eventTimeline, buildOutput, stateTypes, eventTypes, additionalForState, TASK_CONFIG, currentTask};
  }catch(e){ window._oft = {stateTimeline, eventTimeline, buildOutput, stateTypes, eventTypes, additionalForState}; }

})();
