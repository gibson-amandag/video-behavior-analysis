# Video Behavior Scoring — Open Field Test (OFT)

This is a minimal, local, browser-based tool to score Open Field Test videos.

- Open `index.html` in a browser (or run a simple static server: `python -m http.server`).
- Load a video, set starting state, add state transitions and events, then export a single JSON per session.

Files added:
- index.html — main UI
- src/js/app.js — scoring engine + UI glue
- src/css/styles.css — basic styling
- config/open_field.yaml — task config for OFT

Follow the project instructions in the repository root for design and schema.
# video-behavior-analysis