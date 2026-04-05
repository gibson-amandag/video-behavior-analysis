// Minimal OFT scoring engine (served under www/ for Shiny)
(function(){
  const TOOL_VERSION = "0.1.0";
  const TASK_CONFIG = "config/open_field.yaml";

  // State and event timelines
  let stateTimeline = []; // entries: {start: seconds, state: 'EDGE'|'CENTER'}
  let eventTimeline = []; // entries: {start, end, event}
  let activeEvents = {}; // eventName -> startTime

  // DOM
  const videoFile = document.getElementById('videoFile');
  const video = document.getElementById('videoPlayer');
  const addStateBtn = document.getElementById('addState');
  const stateList = document.getElementById('stateList');
  const eventList = document.getElementById('eventList');
  const startEventBtn = document.getElementById('startEvent');
  const stopEventBtn = document.getElementById('stopEvent');
  const eventTypeSel = document.getElementById('eventType');
  const exportJsonBtn = document.getElementById('exportJson');
  const exportCsvBtn = document.getElementById('exportCsv');
  const clearAllBtn = document.getElementById('clearAll');
  const setStartStateBtn = document.getElementById('setStartState');
  const startStateSel = document.getElementById('startState');

  function seconds(){ return video.currentTime || 0; }

  videoFile.addEventListener('change', (e)=>{
    const f = e.target.files[0];
    if(!f) return;
    video.src = URL.createObjectURL(f);
    video.dataset.filename = f.name;
  });

  setStartStateBtn.addEventListener('click', ()=>{
    const s = startStateSel.value;
    stateTimeline = [{start:0, state: s}];
    renderStateList();
    saveAutosave();
  });

  addStateBtn.addEventListener('click', ()=>{
    const t = +seconds().toFixed(3);
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
    stateList.innerHTML = '';
    const dur = video.duration || null;
    for(let i=0;i<stateTimeline.length;i++){
      const a = stateTimeline[i];
      const b = stateTimeline[i+1];
      const li = document.createElement('li');
      li.textContent = `${a.start.toFixed(3)} → ${b ? b.start.toFixed(3) : (dur?dur.toFixed(3):'ONGOING')} : ${a.state}`;
      const del = document.createElement('button'); del.textContent='Delete';
      del.addEventListener('click', ()=>{ stateTimeline.splice(i,1); renderStateList(); saveAutosave(); });
      li.appendChild(del);
      stateList.appendChild(li);
    }
  }

  function renderEventList(){
    eventList.innerHTML = '';
    // active events
    Object.keys(activeEvents).forEach(ev=>{
      const li = document.createElement('li');
      li.textContent = `${activeEvents[ev].toFixed(3)} → (active) : ${ev}`;
      const stop = document.createElement('button'); stop.textContent='Stop';
      stop.addEventListener('click', ()=>{ video.currentTime = activeEvents[ev]; delete activeEvents[ev]; renderEventList(); saveAutosave(); });
      li.appendChild(stop);
      eventList.appendChild(li);
    });
    // finished events
    for(let i=0;i<eventTimeline.length;i++){
      const e = eventTimeline[i];
      const li = document.createElement('li');
      li.textContent = `${e.start.toFixed(3)} → ${e.end.toFixed(3)} : ${e.event}`;
      const del = document.createElement('button'); del.textContent='Delete';
      del.addEventListener('click', ()=>{ eventTimeline.splice(i,1); renderEventList(); saveAutosave(); });
      li.appendChild(del);
      eventList.appendChild(li);
    }
  }

  exportJsonBtn.addEventListener('click', ()=>{
    const out = buildOutput();
    const filename = `${out.session_id || 'session'}.json`;
    download(JSON.stringify(out, null, 2), filename, 'application/json');
  });

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
    const duration = video.duration || null;
    // compute state timeline with end times
    const states = stateTimeline.map((s,i)=>{
      const next = stateTimeline[i+1];
      return {start: s.start, end: next? next.start : (duration||null), state: s.state};
    });
    const out = {
      session_id: `${document.getElementById('subjectId').value || 'subject'}_OFT_${document.getElementById('date').value || new Date().toISOString().slice(0,10)}`,
      task: 'open_field',
      duration_s: duration,
      subject: {species:'rat', id: document.getElementById('subjectId').value || ''},
      metadata: { video_file: video.dataset.filename||'', date: document.getElementById('date').value||'', time: document.getElementById('time').value||'', scorer: document.getElementById('scorer').value||'', comments: '' },
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
    const state = {stateTimeline, eventTimeline, activeEvents, metadata:{scorer:document.getElementById('scorer').value, subjectId:document.getElementById('subjectId').value}};
    try{ localStorage.setItem(AS_KEY, JSON.stringify(state)); }catch(e){}
  }
  function loadAutosave(){
    try{ const raw = localStorage.getItem(AS_KEY); if(raw){ const s = JSON.parse(raw); if(s.stateTimeline) stateTimeline = s.stateTimeline; if(s.eventTimeline) eventTimeline = s.eventTimeline; if(s.activeEvents) activeEvents = s.activeEvents; renderStateList(); renderEventList(); } }catch(e){}
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
  loadAutosave(); loadConfig();

  // expose for debugging
  window._oft = {stateTimeline, eventTimeline, buildOutput};

})();
