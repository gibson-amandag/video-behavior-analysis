// Minimal OFT scoring engine (served under www/ for Shiny)
(function(){
  const TOOL_VERSION = "0.1.0";
  const TASK_CONFIG = "config/open_field.yaml";

  // State and event timelines
  let stateTimeline = []; // entries: {start: seconds, state: 'EDGE'|'CENTER'}
  let eventTimeline = []; // entries: {start, end, event}
  let activeEvents = {}; // eventName -> startTime
  let subjectInTime = null; // seconds when subject placed in apparatus
  let savedAutosave = null; // raw autosave stash (do not auto-apply)

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
  const videoDurInput = document.getElementById('videoDur');
  const stepInput = document.getElementById('stepSize');
  const addStateBtn = document.getElementById('addState');
  const stateTableBody = document.getElementById('stateTableBody');
  const eventTableBody = document.getElementById('eventTableBody');
  const startEventBtn = document.getElementById('startEvent');
  const stopEventBtn = document.getElementById('stopEvent');
  const eventTypeSel = document.getElementById('eventType');
  const exportJsonBtn = document.getElementById('exportJson');
  const exportCsvBtn = document.getElementById('exportCsv');
  const clearAllBtn = document.getElementById('clearAll');
  const importJsonFile = document.getElementById('importJsonFile');
  const setStartStateBtn = document.getElementById('setStartState');
  const startStateSel = document.getElementById('startState');

  function seconds(){ return video.currentTime || 0; }

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

  function renderSubjectIn(){
    let txt = `Subject in: ${subjectInTime!==null? formatTimeSec(subjectInTime): '—'}`;
    // if duration available, show computed session end time
    let dur = null;
    if(videoDurInput && videoDurInput.value){ const p = parseFloat(videoDurInput.value); if(!Number.isNaN(p)) dur = p; }
    if(subjectInTime !== null && dur !== null){ const endt = subjectInTime + dur; txt += ` — session end: ${formatTimeSec(endt)}`; }
    subjectInDisplay.textContent = txt;
  }

  videoFile.addEventListener('change', (e)=>{
    const f = e.target.files[0];
    if(!f) return;
    video.src = URL.createObjectURL(f);
    video.dataset.filename = f.name;
    if(videoFileDisplay) videoFileDisplay.textContent = `File: ${f.name}`;
    // apply selected playback speed when loading a file
    const sp = parseFloat(changeSpeed && changeSpeed.value) || 1.0;
    video.playbackRate = sp;
    // If there's a saved autosave that matches this video's filename, offer to restore it as a backup.
    try{
      if(savedAutosave && savedAutosave.metadata && savedAutosave.metadata.video_file && savedAutosave.metadata.video_file === f.name){
        const ok = confirm('Found a local autosave for this video. Restore annotations from local backup?');
        if(ok) applyAutosave(savedAutosave);
      }
    }catch(e){}
  });

  // Do NOT auto-fill duration from video; default is provided in the form (600s)

  // Mark subject in / clear
  if(markInBtn){ markInBtn.addEventListener('click', ()=>{
    subjectInTime = +seconds().toFixed(3);
    // initialize state timeline to start at the subject placement time
    try{
      const startState = (startStateSel && startStateSel.value) ? startStateSel.value : 'EDGE';
      stateTimeline = [{start: subjectInTime, state: startState}];
    }catch(e){ stateTimeline = [{start: subjectInTime, state: 'EDGE'}]; }
    renderSubjectIn(); renderStateList();
    saveAutosave();
  }); }
  if(clearInBtn){ clearInBtn.addEventListener('click', ()=>{
    subjectInTime = null;
    // clear state timeline because timeline must begin at subject placement
    stateTimeline = [];
    renderSubjectIn(); renderStateList();
    saveAutosave();
  }); }

  if(setStartStateBtn){
    setStartStateBtn.addEventListener('click', ()=>{
      const s = startStateSel.value;
      stateTimeline = [{start:0, state: s}];
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
    
    // alternate speed keys requested: q/w/a/s
    if(e.key === 'q'){ setSpeedVal(0.5); }
    if(e.key === 'w'){ setSpeedVal(1.0); }
    if(e.key === 'a'){ setSpeedVal(2.0); }
    if(e.key === 's'){ setSpeedVal(3.0); }

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
    if(e.key === 'x'){ // play/pause toggle
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

    // events: toggle grooming / rearing
    if(e.key === 'g'){ toggleEventByName('GROOMING'); }
    if(e.key === 'r'){ toggleEventByName('REARING'); }

    // state switch
    if(e.key === 'v'){ if(addStateBtn) addStateBtn.click(); }
  });

  // helper: toggle named event start/stop
  function toggleEventByName(evName){
    if(!evName) return;
    if(activeEvents[evName]){
      // stop
      const s = activeEvents[evName];
      const e = +seconds().toFixed(3);
      eventTimeline.push({start: s, end: e, event: evName});
      delete activeEvents[evName];
      renderEventList(); saveAutosave();
    } else {
      // start
      activeEvents[evName] = +seconds().toFixed(3);
      renderEventList(); saveAutosave();
    }
  }

  addStateBtn.addEventListener('click', ()=>{
    if(subjectInTime === null){ alert('Please mark subject start time before adding state transitions.'); return; }
    const t = +seconds().toFixed(3);
    // prevent adding transitions before subject placement
    if(t < subjectInTime){ alert('State transitions must occur at or after subject placement time.'); return; }
    // toggle to other state if same as last
    const last = stateTimeline[stateTimeline.length-1];
    const nextState = last && last.state === 'EDGE' ? 'CENTER' : 'EDGE';
    stateTimeline.push({start: t, state: nextState});
    renderStateList();
    saveAutosave();
  });

  startEventBtn.addEventListener('click', ()=>{
    const ev = eventTypeSel.value;
    if(activeEvents[ev]){ alert('Event already active'); return; }
    activeEvents[ev] = +seconds().toFixed(3);
    renderEventList();
    saveAutosave();
  });

  stopEventBtn.addEventListener('click', ()=>{
    const ev = eventTypeSel.value;
    const s = activeEvents[ev];
    if(!s){ alert('No active event to stop'); return; }
    const e = +seconds().toFixed(3);
    eventTimeline.push({start: s, end: e, event: ev});
    delete activeEvents[ev];
    renderEventList();
    saveAutosave();
  });

  function renderStateList(){
    if(!stateTableBody) return;
    stateTableBody.innerHTML = '';
    // compute session duration end time (subjectInTime + duration)
    let dur = null;
    if(videoDurInput && videoDurInput.value){ const p = parseFloat(videoDurInput.value); if(!Number.isNaN(p)) dur = p; }
    for(let i=0;i<stateTimeline.length;i++){
      const a = stateTimeline[i];
      const b = stateTimeline[i+1];
      const tr = document.createElement('tr');
      const tdState = document.createElement('td'); tdState.textContent = a.state;
      const tdAt = document.createElement('td'); tdAt.textContent = (typeof a.start === 'number')? a.start.toFixed(3) : '—';
      const tdStamp = document.createElement('td');
      const link = document.createElement('a'); link.href = '#'; link.textContent = formatTimeSec(a.start);
      link.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ video.currentTime = a.start; video.pause(); }catch(e){} });
      tdStamp.appendChild(link);
      const tdDur = document.createElement('td');
      let durVal = null;
      if(b && typeof b.start === 'number') durVal = b.start - a.start;
      else if(dur !== null && subjectInTime !== null) durVal = (subjectInTime + dur) - a.start;
      tdDur.textContent = (durVal !== null && !Number.isNaN(durVal))? durVal.toFixed(3) : '—';
      const tdAct = document.createElement('td');
      const del = document.createElement('button'); del.className = 'btn btn-sm btn-outline-danger'; del.textContent='Delete';
      del.addEventListener('click', ()=>{ stateTimeline.splice(i,1); renderStateList(); saveAutosave(); });
      tdAct.appendChild(del);
      tr.appendChild(tdState); tr.appendChild(tdAt); tr.appendChild(tdStamp); tr.appendChild(tdDur); tr.appendChild(tdAct);
      stateTableBody.appendChild(tr);
    }
  }

  function renderEventList(){
    if(!eventTableBody) return;
    eventTableBody.innerHTML = '';
    // active events (show first)
    Object.keys(activeEvents).forEach(evName=>{
      const start = activeEvents[evName];
      const tr = document.createElement('tr');
      const tdEvent = document.createElement('td'); tdEvent.textContent = evName + ' (active)';
      const tdStart = document.createElement('td'); tdStart.textContent = (typeof start==='number')? start.toFixed(3) : '—';
      const tdStamp = document.createElement('td');
      const link = document.createElement('a'); link.href = '#'; link.textContent = formatTimeSec(start);
      link.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ video.currentTime = start; video.pause(); }catch(e){} });
      tdStamp.appendChild(link);
      const tdDur = document.createElement('td'); tdDur.textContent = 'active';
      const tdAct = document.createElement('td');
      const stopBtn = document.createElement('button'); stopBtn.className = 'btn btn-sm btn-warning me-1'; stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', ()=>{ const e = +seconds().toFixed(3); eventTimeline.push({start: start, end: e, event: evName}); delete activeEvents[evName]; renderEventList(); saveAutosave(); });
      const seekBtn = document.createElement('button'); seekBtn.className = 'btn btn-sm btn-secondary'; seekBtn.textContent = 'Seek';
      seekBtn.addEventListener('click', ()=>{ try{ video.currentTime = start; video.pause(); }catch(e){} });
      tdAct.appendChild(stopBtn); tdAct.appendChild(seekBtn);
      tr.appendChild(tdEvent); tr.appendChild(tdStart); tr.appendChild(tdStamp); tr.appendChild(tdDur); tr.appendChild(tdAct);
      eventTableBody.appendChild(tr);
    });
    // finished events
    for(let i=0;i<eventTimeline.length;i++){
      const e = eventTimeline[i];
      const tr = document.createElement('tr');
      const tdEvent = document.createElement('td'); tdEvent.textContent = e.event;
      const tdStart = document.createElement('td'); tdStart.textContent = (typeof e.start === 'number')? e.start.toFixed(3) : '—';
      const tdStamp = document.createElement('td');
      const link = document.createElement('a'); link.href='#'; link.textContent = formatTimeSec(e.start);
      link.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ video.currentTime = e.start; video.pause(); }catch(err){} });
      tdStamp.appendChild(link);
      const tdDur = document.createElement('td'); tdDur.textContent = ((typeof e.end==='number' && typeof e.start==='number')? (e.end - e.start).toFixed(3) : '—');
      const tdAct = document.createElement('td');
      const del = document.createElement('button'); del.className = 'btn btn-sm btn-outline-danger'; del.textContent='Delete';
      del.addEventListener('click', ()=>{ eventTimeline.splice(i,1); renderEventList(); saveAutosave(); });
      tdAct.appendChild(del);
      tr.appendChild(tdEvent); tr.appendChild(tdStart); tr.appendChild(tdStamp); tr.appendChild(tdDur); tr.appendChild(tdAct);
      eventTableBody.appendChild(tr);
    }
  }

  exportJsonBtn.addEventListener('click', ()=>{
    const out = buildOutput();
    const filename = `${out.session_id || 'session'}.json`;
    download(JSON.stringify(out, null, 2), filename, 'application/json');
  });

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

  exportCsvBtn.addEventListener('click', ()=>{
    const out = buildOutput();
    // states CSV
    const statesCsv = ['start,end,state'];
    out.state_timeline.forEach(s=> statesCsv.push(`${s.start},${s.end},${s.state}`));
    const eventsCsv = ['start,end,event'];
    out.event_timeline.forEach(e=> eventsCsv.push(`${e.start},${e.end},${e.event}`));
    const csvCombined = ['--- STATES ---'].concat(statesCsv).concat(['','--- EVENTS ---']).concat(eventsCsv).join('\n');
    download(csvCombined, `${out.session_id||'session'}.csv`, 'text/csv');
  });

  clearAllBtn.addEventListener('click', ()=>{
    if(!confirm('Clear all annotations? This cannot be undone.')) return;
    stateTimeline = [];
    eventTimeline = [];
    activeEvents = {};
    renderStateList(); renderEventList(); saveAutosave();
  });

  function buildOutput(){
    // prefer user-provided duration if present, otherwise default to 600s
    let duration = 600;
    if(videoDurInput && videoDurInput.value){
      const parsed = parseFloat(videoDurInput.value);
      if(!Number.isNaN(parsed)) duration = parsed;
    }
    // compute state timeline with end times
    const states = stateTimeline.map((s,i)=>{
      const next = stateTimeline[i+1];
      return {start: s.start, end: next? next.start : (duration||null), state: s.state};
    });
    // compute session end if subject placed
    let session_end = null;
    if(subjectInTime !== null){ session_end = subjectInTime + duration; }
    const out = {
      session_id: `${document.getElementById('subjectId').value || 'subject'}_OFT_${document.getElementById('date').value || new Date().toISOString().slice(0,10)}`,
      task: 'open_field',
      duration_s: duration,
      subject: {species:'rat', id: document.getElementById('subjectId').value || ''},
      metadata: { video_file: video.dataset.filename||'', date: document.getElementById('date').value||'', time: document.getElementById('time').value||'', scorer: document.getElementById('scorer').value||'', comments: '' , subject_placed_at_s: subjectInTime, session_end_s: session_end, session_end_note: session_end !== null ? `Computed end = ${formatTimeSec(session_end)} (${session_end.toFixed(3)} s)` : ''},
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
    const state = {stateTimeline, eventTimeline, activeEvents, metadata:{scorer:document.getElementById('scorer').value, subjectId:document.getElementById('subjectId').value, subject_in_time_s: subjectInTime, video_duration_s: vidDur, video_file: video.dataset.filename || (videoFile && videoFile.files && videoFile.files[0] && videoFile.files[0].name) || ''}};
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
      renderStateList(); renderEventList(); renderSubjectIn();
    }catch(e){ console.error('applyAutosave error', e); }
  }

  function applyImportedSession(parsed){
    // parsed may be canonical export (state_timeline/event_timeline) or older autosave shape
    try{
      // states
      if(parsed.state_timeline && Array.isArray(parsed.state_timeline)){
        // convert canonical states (start,end,state) -> internal stateTimeline (start,state)
        stateTimeline = parsed.state_timeline.map(s=>({start: s.start, state: s.state}));
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
    fetch(TASK_CONFIG).then(r=>r.text()).then(txt=>{
      try{ const cfg = jsyaml.load(txt); // not used extensively yet
        if(cfg && cfg.default_start) startStateSel.value = cfg.default_start;
      }catch(e){}
    }).catch(()=>{});
  }

  // init
  loadAutosave();
  loadConfig();

  // expose for debugging
  window._oft = {stateTimeline, eventTimeline, buildOutput};

})();
