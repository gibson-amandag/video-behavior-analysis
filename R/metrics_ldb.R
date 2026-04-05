# metrics_ldb.R
#
# Light–Dark Box (LDB) metrics derived from state and event timelines.
# Uses the same two primitives as OFT (state_timeline, event_timeline) with
# LDB-specific state labels: LIGHT, DARK.
#
# Dependencies: dplyr, tibble
# Usage:
#   source("R/parse_scoring_json.R")
#   source("R/metrics_ldb.R")
#   scoring <- read_scoring_json("path/to/ldb_session.json")
#   metrics <- ldb_metrics(scoring)

library(dplyr)
library(tibble)

# ---------------------------------------------------------------------------
# ldb_state_metrics()
# ---------------------------------------------------------------------------
#' Compute LDB state-based metrics from a state timeline data frame.
#'
#' Expected states: LIGHT, DARK.
#'
#' @param state_df Tibble. state_timeline from read_scoring_json(), containing
#'   columns: start, end, state, duration.
#' @return A named list with:
#'   \item{time_light_s}{Total seconds in the LIGHT compartment.}
#'   \item{time_dark_s}{Total seconds in the DARK compartment.}
#'   \item{n_light_entries}{Number of LIGHT compartment entries.}
#'   \item{n_dark_entries}{Number of DARK compartment entries.}
#'   \item{pct_time_light}{Percentage of session time in LIGHT.}
#'   \item{latency_first_light_s}{Latency (s) to first LIGHT entry;
#'     NA if the animal never entered the LIGHT compartment.}
ldb_state_metrics <- function(state_df) {
  if (!all(c("start", "end", "state", "duration") %in% names(state_df))) {
    stop("state_df must have columns: start, end, state, duration. ",
         "Use read_scoring_json() to parse scoring files.")
  }

  light_rows <- state_df %>% dplyr::filter(.data$state == "LIGHT")
  dark_rows  <- state_df %>% dplyr::filter(.data$state == "DARK")

  total_s       <- sum(state_df$duration, na.rm = TRUE)
  time_light_s  <- sum(light_rows$duration, na.rm = TRUE)
  time_dark_s   <- sum(dark_rows$duration,  na.rm = TRUE)

  pct_time_light <- if (total_s > 0) {
    100 * time_light_s / total_s
  } else {
    NA_real_
  }

  latency_first_light_s <- if (nrow(light_rows) > 0) {
    min(light_rows$start)
  } else {
    NA_real_
  }

  list(
    time_light_s           = time_light_s,
    time_dark_s            = time_dark_s,
    n_light_entries        = nrow(light_rows),
    n_dark_entries         = nrow(dark_rows),
    pct_time_light         = pct_time_light,
    latency_first_light_s  = latency_first_light_s
  )
}

# ---------------------------------------------------------------------------
# ldb_event_metrics()
# ---------------------------------------------------------------------------
#' Compute LDB event-based metrics from an event timeline data frame.
#'
#' Recognized events: GROOMING, REARING.
#'
#' @param event_df Tibble. event_timeline from read_scoring_json(), containing
#'   columns: start, end, event, duration.
#' @return A named list with:
#'   \item{total_grooming_s}{Total seconds grooming.}
#'   \item{n_grooming_bouts}{Number of grooming bouts.}
#'   \item{total_rearing_s}{Total seconds rearing.}
#'   \item{n_rearing}{Number of rearing events.}
ldb_event_metrics <- function(event_df) {
  if (nrow(event_df) > 0 &&
      !all(c("start", "end", "event", "duration") %in% names(event_df))) {
    stop("event_df must have columns: start, end, event, duration. ",
         "Use read_scoring_json() to parse scoring files.")
  }

  grooming_rows <- event_df %>% dplyr::filter(.data$event == "GROOMING")
  rearing_rows  <- event_df %>% dplyr::filter(.data$event == "REARING")

  list(
    total_grooming_s = sum(grooming_rows$duration, na.rm = TRUE),
    n_grooming_bouts = nrow(grooming_rows),
    total_rearing_s  = sum(rearing_rows$duration,  na.rm = TRUE),
    n_rearing        = nrow(rearing_rows)
  )
}

# ---------------------------------------------------------------------------
# ldb_metrics()
# ---------------------------------------------------------------------------
#' Compute all LDB metrics from a parsed scoring object.
#'
#' @param scoring List. Output of read_scoring_json().
#' @return A flat named list combining state and event metrics, plus session_id.
ldb_metrics <- function(scoring) {
  state_m <- ldb_state_metrics(scoring$state_timeline)
  event_m <- ldb_event_metrics(scoring$event_timeline)
  c(list(session_id = scoring$session_id), state_m, event_m)
}

# ---------------------------------------------------------------------------
# ldb_metrics_table()
# ---------------------------------------------------------------------------
#' Compute LDB metrics for a list of scoring objects and return a tidy tibble.
#'
#' @param scoring_list List of scoring objects (each from read_scoring_json()).
#' @return A tibble with one row per session and one column per metric.
ldb_metrics_table <- function(scoring_list) {
  rows <- lapply(scoring_list, ldb_metrics)
  dplyr::bind_rows(lapply(rows, tibble::as_tibble))
}
