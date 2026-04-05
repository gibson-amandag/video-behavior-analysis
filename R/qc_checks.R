# qc_checks.R
#
# Quality-control validation functions for scoring data.
# All functions accept the output of read_scoring_json() and return a list
# with elements `passed` (logical) and `messages` (character vector).
#
# Dependencies: dplyr

library(dplyr)

# ---------------------------------------------------------------------------
# validate_scoring()
# ---------------------------------------------------------------------------
#' Run all QC checks on a parsed scoring object.
#'
#' @param scoring List. Output of read_scoring_json().
#' @param stop_on_error Logical. If TRUE, stop() on the first failed check.
#'   Default FALSE (collect all failures).
#' @return A list with elements:
#'   \item{passed}{Logical. TRUE if every check passed.}
#'   \item{messages}{Character vector of warning/error messages.}
validate_scoring <- function(scoring, stop_on_error = FALSE) {
  messages <- character()

  checks <- list(
    check_required_fields(scoring),
    check_state_coverage(scoring$state_timeline, scoring$duration_s),
    check_state_no_overlap(scoring$state_timeline),
    check_state_no_gaps(scoring$state_timeline, scoring$duration_s),
    check_events_within_session(scoring$event_timeline, scoring$duration_s),
    check_event_durations_positive(scoring$event_timeline),
    check_state_durations_positive(scoring$state_timeline)
  )

  for (chk in checks) {
    if (!chk$passed) {
      messages <- c(messages, chk$messages)
      if (stop_on_error) stop(paste(chk$messages, collapse = "; "))
    }
  }

  list(passed = length(messages) == 0, messages = messages)
}

# ---------------------------------------------------------------------------
# Individual check helpers
# ---------------------------------------------------------------------------

#' Check that all required top-level fields are present.
check_required_fields <- function(scoring) {
  required <- c("session_id", "task", "duration_s", "subject",
                "metadata", "state_timeline", "event_timeline")
  missing  <- setdiff(required, names(scoring))
  if (length(missing) > 0) {
    return(list(passed = FALSE,
                messages = paste("Missing required fields:", paste(missing, collapse = ", "))))
  }
  list(passed = TRUE, messages = character())
}

#' Check that the state timeline starts at 0 and ends at duration_s.
check_state_coverage <- function(state_df, duration_s) {
  messages <- character()
  if (nrow(state_df) == 0) {
    return(list(passed = FALSE, messages = "state_timeline is empty."))
  }
  first_start <- min(state_df$start)
  last_end    <- max(state_df$end)

  if (!isTRUE(all.equal(first_start, 0))) {
    messages <- c(messages,
      sprintf("state_timeline does not start at 0 (first start = %.3f s).", first_start))
  }
  if (!isTRUE(all.equal(last_end, duration_s))) {
    messages <- c(messages,
      sprintf("state_timeline ends at %.3f s but duration_s = %.3f s.", last_end, duration_s))
  }
  list(passed = length(messages) == 0, messages = messages)
}

#' Check that no two states overlap.
check_state_no_overlap <- function(state_df) {
  if (nrow(state_df) < 2) return(list(passed = TRUE, messages = character()))

  sorted <- dplyr::arrange(state_df, .data$start)
  overlaps <- which(sorted$start[-1] < sorted$end[-nrow(sorted)])

  if (length(overlaps) > 0) {
    details <- sapply(overlaps, function(i) {
      sprintf("State %d (%s, %.1f-%.1f) overlaps state %d (%s, %.1f-%.1f).",
              i, sorted$state[i], sorted$start[i], sorted$end[i],
              i + 1, sorted$state[i + 1], sorted$start[i + 1], sorted$end[i + 1])
    })
    return(list(passed = FALSE, messages = details))
  }
  list(passed = TRUE, messages = character())
}

#' Check that there are no gaps between consecutive states.
check_state_no_gaps <- function(state_df, duration_s) {
  if (nrow(state_df) < 2) return(list(passed = TRUE, messages = character()))

  sorted <- dplyr::arrange(state_df, .data$start)
  gaps   <- which(!sapply(seq_len(nrow(sorted) - 1), function(i) {
    isTRUE(all.equal(sorted$end[i], sorted$start[i + 1]))
  }))

  if (length(gaps) > 0) {
    details <- sapply(gaps, function(i) {
      sprintf("Gap in state_timeline between %.3f s and %.3f s.",
              sorted$end[i], sorted$start[i + 1])
    })
    return(list(passed = FALSE, messages = details))
  }
  list(passed = TRUE, messages = character())
}

#' Check that all events fall within [0, duration_s].
check_events_within_session <- function(event_df, duration_s) {
  if (nrow(event_df) == 0) return(list(passed = TRUE, messages = character()))

  outside <- event_df %>%
    dplyr::filter(.data$start < 0 | .data$end > duration_s)

  if (nrow(outside) > 0) {
    details <- sprintf("Event '%s' (%.1f-%.1f s) falls outside session duration (0-%.1f s).",
                       outside$event, outside$start, outside$end, duration_s)
    return(list(passed = FALSE, messages = details))
  }
  list(passed = TRUE, messages = character())
}

#' Check that all event durations are positive.
check_event_durations_positive <- function(event_df) {
  if (nrow(event_df) == 0) return(list(passed = TRUE, messages = character()))

  bad <- event_df %>% dplyr::filter(.data$end <= .data$start)
  if (nrow(bad) > 0) {
    details <- sprintf("Event '%s' has non-positive duration (start=%.3f, end=%.3f).",
                       bad$event, bad$start, bad$end)
    return(list(passed = FALSE, messages = details))
  }
  list(passed = TRUE, messages = character())
}

#' Check that all state durations are positive.
check_state_durations_positive <- function(state_df) {
  if (nrow(state_df) == 0) return(list(passed = TRUE, messages = character()))

  bad <- state_df %>% dplyr::filter(.data$end <= .data$start)
  if (nrow(bad) > 0) {
    details <- sprintf("State '%s' has non-positive duration (start=%.3f, end=%.3f).",
                       bad$state, bad$start, bad$end)
    return(list(passed = FALSE, messages = details))
  }
  list(passed = TRUE, messages = character())
}
