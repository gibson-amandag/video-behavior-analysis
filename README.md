# Video Behavior Scoring — Open Field Test (OFT)

This is a minimal, local, browser-based tool to score Open Field Test videos.

- Open `index.html` in a browser (or run a simple static server: `python -m http.server`).
- Load a video, set starting state, add state transitions and events, then export a single JSON per session.
- Use the **Spreadsheet conversion** tab to select the behavior (OFT, Light-Dark Box, or Elevated Plus Maze), enter the video filename, paste state timestamp/state columns and one start/end pair table per configured event, review the generated JSON, and download it. The converter task selection stays synchronized with the app's task selector.
- The converter requires the placement offset in video time (seconds, `MM:SS`, or `HH:MM:SS`). Choose whether pasted times are video time, elapsed since placement, or clock time; clock-time conversion also requires the clock time of placement. Elapsed timestamps may be entered as seconds, `MM:SS`, or `HH:MM:SS`.

Files added:
- index.html — main UI
- src/js/app.js — scoring engine + UI glue
- src/css/styles.css — basic styling
- config/open_field.yaml — task config for OFT

Follow the project instructions in the repository root for design and schema.
# video-behavior-analysis