# parse_scoring_json.R
#
# Functions for reading scoring JSON files produced by scoring tools and
# converting them into tidy data frames used by all downstream analysis.
#
# Dependencies: jsonlite, dplyr, tibble
# Usage:
#   scoring <- read_scoring_json("path/to/session.json")
#   state_df <- scoring$state_timeline
#   event_df <- scoring$event_timeline

library(jsonlite)
library(dplyr)
library(tibble)

# ---------------------------------------------------------------------------
# read_scoring_json()
# ---------------------------------------------------------------------------
#' Read a scoring JSON file and return a structured list.
#'
#' @param path Character. Path to the scoring JSON file.
#' @return A named list with elements:
#'   \item{session_id}{Character. Session identifier.}
#'   \item{task}{Character. Behavioral paradigm.}
#'   \item{duration_s}{Numeric. Total session duration (s).}
#'   \item{subject}{Named list. Species and id fields.}
#'   \item{metadata}{Named list. Video file, date, scorer, etc.}
#'   \item{state_timeline}{Tibble with columns: start, end, state, duration.}
#'   \item{event_timeline}{Tibble with columns: start, end, event, duration.}
#'   \item{tool_version}{Character. Scoring tool version.}
#'   \item{task_config}{Character or NA. Task config filename.}
read_scoring_json <- function(path) {
  if (!file.exists(path)) {
    stop("Scoring file not found: ", path)
  }

  raw <- jsonlite::fromJSON(path, simplifyVector = TRUE, simplifyDataFrame = TRUE)

  state_df <- tibble::as_tibble(raw$state_timeline) %>%
    dplyr::mutate(
      start    = as.numeric(.data$start),
      end      = as.numeric(.data$end),
      state    = as.character(.data$state),
      duration = .data$end - .data$start
    ) %>%
    dplyr::arrange(.data$start)

  event_df <- if (length(raw$event_timeline) == 0) {
    tibble::tibble(start = numeric(), end = numeric(),
                   event = character(), duration = numeric())
  } else {
    tibble::as_tibble(raw$event_timeline) %>%
      dplyr::mutate(
        start    = as.numeric(.data$start),
        end      = as.numeric(.data$end),
        event    = as.character(.data$event),
        duration = .data$end - .data$start
      ) %>%
      dplyr::arrange(.data$start)
  }

  list(
    session_id     = raw$session_id,
    task           = raw$task,
    duration_s     = as.numeric(raw$duration_s),
    subject        = raw$subject,
    metadata       = raw$metadata,
    state_timeline = state_df,
    event_timeline = event_df,
    tool_version   = raw$tool_version,
    task_config    = if (!is.null(raw$task_config)) raw$task_config else NA_character_
  )
}
