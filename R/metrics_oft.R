# metrics_oft.R
#
# Open Field Test (OFT) metrics derived from state and event timelines.
# All metrics are computed from raw timelines; no derived values are ever
# stored in scoring files (see section 5 of the project specification).
#
# Dependencies: dplyr, tibble
# Usage:
#   source("R/parse_scoring_json.R")
#   source("R/metrics_oft.R")
#   scoring  <- read_scoring_json("examples/oft_example_scoring.json")
#   state_m  <- oft_state_metrics(scoring$state_timeline)
#   event_m  <- oft_event_metrics(scoring$event_timeline)

library(dplyr)
library(tibble)

# ---------------------------------------------------------------------------
# oft_state_metrics()
# ---------------------------------------------------------------------------
#' Compute OFT state-based metrics from a state timeline data frame.
#'
#' Expected states: CENTER, EDGE (mutually exclusive, covering full session).
#'
#' @param state_df Tibble. state_timeline from read_scoring_json(), containing
#'   columns: start, end, state, duration.
#' @return A named list with:
#'   \item{time_center_s}{Total seconds spent in CENTER.}
#'   \item{time_edge_s}{Total seconds spent in EDGE.}
#'   \item{n_center_entries}{Number of times the animal entered CENTER.}
#'   \item{n_crossings}{Total number of CENTER entries (synonym for crossings).}
#'   \item{latency_first_center_s}{Latency (s) to first CENTER entry;
#'     NA if no CENTER entry occurred.}
oft_state_metrics <- function(state_df) {
  if (!all(c("start", "end", "state", "duration") %in% names(state_df))) {
    stop("state_df must have columns: start, end, state, duration. ",
         "Use read_scoring_json() to parse scoring files.")
  }

  center_rows <- state_df %>% dplyr::filter(.data$state == "CENTER")
  edge_rows   <- state_df %>% dplyr::filter(.data$state == "EDGE")

  time_center_s <- sum(center_rows$duration, na.rm = TRUE)
  time_edge_s   <- sum(edge_rows$duration,   na.rm = TRUE)

  n_center_entries <- nrow(center_rows)

  latency_first_center_s <- if (n_center_entries > 0) {
    min(center_rows$start)
  } else {
    NA_real_
  }

  list(
    time_center_s            = time_center_s,
    time_edge_s              = time_edge_s,
    n_center_entries         = n_center_entries,
    n_crossings              = n_center_entries,
    latency_first_center_s   = latency_first_center_s
  )
}

# ---------------------------------------------------------------------------
# oft_event_metrics()
# ---------------------------------------------------------------------------
#' Compute OFT event-based metrics from an event timeline data frame.
#'
#' Recognized events: GROOMING, REARING.
#'
#' @param event_df Tibble. event_timeline from read_scoring_json(), containing
#'   columns: start, end, event, duration.
#' @return A named list with:
#'   \item{total_grooming_s}{Total seconds spent grooming.}
#'   \item{n_grooming_bouts}{Number of grooming bouts.}
#'   \item{total_rearing_s}{Total seconds spent rearing.}
#'   \item{n_rearing}{Number of rearing events.}
oft_event_metrics <- function(event_df) {
  if (nrow(event_df) > 0 &&
      !all(c("start", "end", "event", "duration") %in% names(event_df))) {
    stop("event_df must have columns: start, end, event, duration. ",
         "Use read_scoring_json() to parse scoring files.")
  }

  grooming_rows <- event_df %>% dplyr::filter(.data$event == "GROOMING")
  rearing_rows  <- event_df %>% dplyr::filter(.data$event == "REARING")

  list(
    total_grooming_s  = sum(grooming_rows$duration, na.rm = TRUE),
    n_grooming_bouts  = nrow(grooming_rows),
    total_rearing_s   = sum(rearing_rows$duration,  na.rm = TRUE),
    n_rearing         = nrow(rearing_rows)
  )
}

# ---------------------------------------------------------------------------
# oft_metrics()
# ---------------------------------------------------------------------------
#' Compute all OFT metrics from a parsed scoring object.
#'
#' Convenience wrapper that calls oft_state_metrics() and oft_event_metrics()
#' and returns a flat named list of all metrics.
#'
#' @param scoring List. Output of read_scoring_json().
#' @return A flat named list combining state and event metrics, plus session_id.
oft_metrics <- function(scoring) {
  state_m <- oft_state_metrics(scoring$state_timeline)
  event_m <- oft_event_metrics(scoring$event_timeline)
  c(list(session_id = scoring$session_id), state_m, event_m)
}

# ---------------------------------------------------------------------------
# oft_metrics_table()
# ---------------------------------------------------------------------------
#' Compute OFT metrics for a list of scoring objects and return a tidy tibble.
#'
#' @param scoring_list List of scoring objects (each from read_scoring_json()).
#' @return A tibble with one row per session and one column per metric.
oft_metrics_table <- function(scoring_list) {
  rows <- lapply(scoring_list, oft_metrics)
  dplyr::bind_rows(lapply(rows, tibble::as_tibble))
}
