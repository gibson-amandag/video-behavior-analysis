# video-behavior-analysis

R-based analysis system for behavioral scoring data produced by the Gibson Lab
scoring tools. Parses JSON scoring files, validates their integrity, and
computes reproducible metrics for Open Field Test (OFT), Elevated Plus Maze
(EPM), and Light–Dark Box (LDB) paradigms.

---

## Repository Structure

```
video-behavior-analysis/
├── R/
│   ├── parse_scoring_json.R      # Read scoring JSON → tidy data frames
│   ├── qc_checks.R               # Validate scoring file integrity
│   ├── metrics_oft.R             # Open Field Test metrics
│   ├── metrics_epm.R             # Elevated Plus Maze metrics
│   ├── metrics_ldb.R             # Light–Dark Box metrics
│   └── visualization_timeline.R  # ggplot2 timeline and summary plots
├── schemas/
│   └── scoring_schema.json       # JSON Schema for scoring output files
├── examples/
│   └── oft_example_scoring.json  # Example OFT scoring file
├── docs/
│   ├── oft_analysis_protocol.md  # Step-by-step OFT analysis guide
│   └── metrics_definitions.md    # Definitions for all computed metrics
└── README.md
```

---

## Quick Start

### 1. Install dependencies

```r
install.packages(c("jsonlite", "dplyr", "tibble", "ggplot2"))
```

### 2. Source the analysis files

```r
source("R/parse_scoring_json.R")
source("R/qc_checks.R")
source("R/metrics_oft.R")
source("R/visualization_timeline.R")
```

### 3. Parse, validate, and compute metrics

```r
scoring <- read_scoring_json("examples/oft_example_scoring.json")

# Validate integrity
qc <- validate_scoring(scoring)
if (!qc$passed) stop(paste(qc$messages, collapse = "\n"))

# Compute OFT metrics
metrics <- oft_metrics(scoring)
print(metrics)
```

### 4. Visualise a session

```r
p <- plot_timeline(scoring)
print(p)
```

---

## Design Principles

- **Derived metrics are never stored** – all values are recomputed from raw
  timelines on each analysis run.
- **Two primitives, all paradigms** – every task uses the same state timeline
  (mutually exclusive zones) and event timeline (discrete behaviours).
- **File-based, no platform lock-in** – scoring files are plain JSON; analysis
  is plain R scripts.
- **Extensible** – adding a new paradigm means writing a new `metrics_*.R`
  file using the same input data frames.

---

## Documentation

- [OFT Analysis Protocol](docs/oft_analysis_protocol.md)
- [Metrics Definitions](docs/metrics_definitions.md)
- [Scoring JSON Schema](schemas/scoring_schema.json)

---

## What This Repository Does Not Contain

- Raw videos
- Real subject data
- Student-generated scoring files
- Large binary artifacts

---

## Supported Paradigms

| Paradigm | State labels | Metrics file |
|----------|-------------|--------------|
| Open Field Test | `CENTER`, `EDGE` | `R/metrics_oft.R` |
| Elevated Plus Maze | `OPEN_ARM`, `CLOSED_ARM`, `CENTER` | `R/metrics_epm.R` |
| Light–Dark Box | `LIGHT`, `DARK` | `R/metrics_ldb.R` |