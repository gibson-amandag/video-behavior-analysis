# metrics_epm.R
#
# Elevated Plus Maze (EPM) metrics derived from state and event timelines.
# Uses the same two primitives as OFT (state_timeline, event_timeline) with
# EPM-specific state labels: OPEN_ARM, CLOSED_ARM, CENTER.
#
# Dependencies: dplyr, tibble
# Usage:
#   source("R/parse_scoring_json.R")
#   source("R/metrics_epm.R")
#   scoring <- read_scoring_json("path/to/epm_session.json")
#   metrics <- epm_metrics(scoring)

library(dplyr)
library(tibble)

# ---------------------------------------------------------------------------
# epm_state_metrics()
# ---------------------------------------------------------------------------
#' Compute EPM state-based metrics from a state timeline data frame.
#'
#' Expected states: OPEN_ARM, CLOSED_ARM, CENTER.
#'
#' @param state_df Tibble. state_timeline from read_scoring_json(), containing
#'   columns: start, end, state, duration.
#' @return A named list with:
#'   \item{time_open_arm_s}{Total seconds in OPEN_ARM.}
#'   \item{time_closed_arm_s}{Total seconds in CLOSED_ARM.}
#'   \item{time_center_s}{Total seconds in CENTER.}
#'   \item{n_open_arm_entries}{Number of OPEN_ARM entries.}
#'   \item{n_closed_arm_entries}{Number of CLOSED_ARM entries.}
#'   \item{pct_time_open_arm}{Percentage of session time in OPEN_ARM.}
#'   \item{latency_first_open_arm_s}{Latency (s) to first OPEN_ARM entry;
#'     NA if no open arm entry occurred.}
epm_state_metrics <- function(state_df) {
  if (!all(c("start", "end", "state", "duration") %in% names(state_df))) {
    stop("state_df must have columns: start, end, state, duration. ",
         "Use read_scoring_json() to parse scoring files.")
  }

  open_rows   <- state_df %>% dplyr::filter(.data$state == "OPEN_ARM")
  closed_rows <- state_df %>% dplyr::filter(.data$state == "CLOSED_ARM")
  center_rows <- state_df %>% dplyr::filter(.data$state == "CENTER")

  total_s          <- sum(state_df$duration, na.rm = TRUE)
  time_open_arm_s  <- sum(open_rows$duration,   na.rm = TRUE)
  time_closed_arm_s <- sum(closed_rows$duration, na.rm = TRUE)
  time_center_s    <- sum(center_rows$duration,  na.rm = TRUE)

  pct_time_open_arm <- if (total_s > 0) {
    100 * time_open_arm_s / total_s
  } else {
    NA_real_
  }

  latency_first_open_arm_s <- if (nrow(open_rows) > 0) {
    min(open_rows$start)
  } else {
    NA_real_
  }

  list(
    time_open_arm_s           = time_open_arm_s,
    time_closed_arm_s         = time_closed_arm_s,
    time_center_s             = time_center_s,
    n_open_arm_entries        = nrow(open_rows),
    n_closed_arm_entries      = nrow(closed_rows),
    pct_time_open_arm         = pct_time_open_arm,
    latency_first_open_arm_s  = latency_first_open_arm_s
  )
}

# ---------------------------------------------------------------------------
# epm_event_metrics()
# ---------------------------------------------------------------------------
#' Compute EPM event-based metrics from an event timeline data frame.
#'
#' Recognized events: HEAD_DIP, RISK_ASSESSMENT, GROOMING, REARING.
#'
#' @param event_df Tibble. event_timeline from read_scoring_json(), containing
#'   columns: start, end, event, duration.
#' @return A named list with:
#'   \item{n_head_dips}{Number of HEAD_DIP events.}
#'   \item{total_head_dip_s}{Total seconds in HEAD_DIP.}
#'   \item{n_risk_assessments}{Number of RISK_ASSESSMENT events.}
#'   \item{total_risk_assessment_s}{Total seconds in RISK_ASSESSMENT.}
#'   \item{total_grooming_s}{Total seconds grooming.}
#'   \item{n_grooming_bouts}{Number of grooming bouts.}
epm_event_metrics <- function(event_df) {
  if (nrow(event_df) > 0 &&
      !all(c("start", "end", "event", "duration") %in% names(event_df))) {
    stop("event_df must have columns: start, end, event, duration. ",
         "Use read_scoring_json() to parse scoring files.")
  }

  head_dip_rows  <- event_df %>% dplyr::filter(.data$event == "HEAD_DIP")
  risk_rows      <- event_df %>% dplyr::filter(.data$event == "RISK_ASSESSMENT")
  grooming_rows  <- event_df %>% dplyr::filter(.data$event == "GROOMING")

  list(
    n_head_dips              = nrow(head_dip_rows),
    total_head_dip_s         = sum(head_dip_rows$duration, na.rm = TRUE),
    n_risk_assessments       = nrow(risk_rows),
    total_risk_assessment_s  = sum(risk_rows$duration, na.rm = TRUE),
    total_grooming_s         = sum(grooming_rows$duration, na.rm = TRUE),
    n_grooming_bouts         = nrow(grooming_rows)
  )
}

# ---------------------------------------------------------------------------
# epm_metrics()
# ---------------------------------------------------------------------------
#' Compute all EPM metrics from a parsed scoring object.
#'
#' @param scoring List. Output of read_scoring_json().
#' @return A flat named list combining state and event metrics, plus session_id.
epm_metrics <- function(scoring) {
  state_m <- epm_state_metrics(scoring$state_timeline)
  event_m <- epm_event_metrics(scoring$event_timeline)
  c(list(session_id = scoring$session_id), state_m, event_m)
}

# ---------------------------------------------------------------------------
# epm_metrics_table()
# ---------------------------------------------------------------------------
#' Compute EPM metrics for a list of scoring objects and return a tidy tibble.
#'
#' @param scoring_list List of scoring objects (each from read_scoring_json()).
#' @return A tibble with one row per session and one column per metric.
epm_metrics_table <- function(scoring_list) {
  rows <- lapply(scoring_list, epm_metrics)
  dplyr::bind_rows(lapply(rows, tibble::as_tibble))
}
