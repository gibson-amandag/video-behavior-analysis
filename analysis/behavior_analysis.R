# Behavioral JSON import and summary functions
# AI model disclosure: AI-assisted with Copilot SDK in VS Code. The exact
# underlying model identity was not exposed during authoring.

# Required packages: jsonlite, dplyr, tibble

.behavior_value <- function(x, key, default = NULL) {
  if (is.list(x) && key %in% names(x) && !is.null(x[[key]])) {
    x[[key]]
  } else {
    default
  }
}

.behavior_number <- function(x, label, file, required = FALSE) {
  if (is.null(x) && !required) {
    return(NA_real_)
  }
  if (!is.numeric(x) || length(x) != 1L || !is.finite(x)) {
    stop(sprintf("Expected a finite numeric value for %s in '%s'.", label, file),
         call. = FALSE)
  }
  as.numeric(x)
}

.behavior_bind_rows <- function(rows, empty) {
  if (length(rows) == 0L) empty else dplyr::bind_rows(rows)
}

#' Read exported scoring JSON files into session, state, and event tables
#'
#' `paths` may contain individual JSON files, directories, or a mixture. JSON
#' files within directories are discovered recursively. Timeline times are
#' returned as seconds since subject placement.
#'
#' @param paths Character vector of JSON file or directory paths.
#' @return A list with `sessions`, `state_bouts`, and `event_bouts` tibbles.
read_behavior_json <- function(paths) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("Package 'jsonlite' is required. Install it with install.packages('jsonlite').",
         call. = FALSE)
  }
  if (!requireNamespace("dplyr", quietly = TRUE) ||
      !requireNamespace("tibble", quietly = TRUE)) {
    stop("Packages 'dplyr' and 'tibble' are required. Install the tidyverse.",
         call. = FALSE)
  }
  if (!is.character(paths) || length(paths) == 0L || anyNA(paths)) {
    stop("`paths` must be a non-empty character vector of file or directory paths.",
         call. = FALSE)
  }

  missing_paths <- paths[!file.exists(paths)]
  if (length(missing_paths) > 0L) {
    stop(sprintf("Path does not exist: %s", paste(missing_paths, collapse = ", ")),
         call. = FALSE)
  }

  json_files <- unlist(lapply(paths, function(path) {
    if (dir.exists(path)) {
      list.files(path, pattern = "\\.json$", recursive = TRUE,
                 full.names = TRUE, ignore.case = TRUE)
    } else if (grepl("\\.json$", path, ignore.case = TRUE)) {
      path
    } else {
      character()
    }
  }), use.names = FALSE)
  json_files <- unique(json_files)
  if (length(json_files) == 0L) {
    stop("No JSON files found in the supplied paths.", call. = FALSE)
  }

  sessions <- list()
  state_bouts <- list()
  event_bouts <- list()

  for (file in json_files) {
    parsed <- tryCatch(
      jsonlite::fromJSON(file, simplifyVector = FALSE),
      error = function(error) {
        stop(sprintf("Could not parse JSON file '%s': %s",
                     file, conditionMessage(error)), call. = FALSE)
      }
    )
    if (!is.list(parsed)) {
      stop(sprintf("Expected a JSON object in '%s'.", file), call. = FALSE)
    }

    metadata <- .behavior_value(parsed, "metadata", list())
    subject <- .behavior_value(parsed, "subject", list())
    session_id <- .behavior_value(parsed, "session_id", tools::file_path_sans_ext(basename(file)))
    task <- .behavior_value(parsed, "task", NA_character_)
    if (!is.character(task) || length(task) != 1L || is.na(task) ||
        !nzchar(task)) {
      stop(sprintf("Expected a non-empty task name in '%s'.", file),
           call. = FALSE)
    }
    placement <- .behavior_number(
      .behavior_value(metadata, "subject_placed_at_s",
                      .behavior_value(metadata, "subject_in_time_s")),
      "metadata.subject_placed_at_s", file
    )
    duration <- .behavior_number(.behavior_value(parsed, "duration_s"),
                                 "duration_s", file)

    states <- .behavior_value(parsed, "state_timeline", list())
    events <- .behavior_value(parsed, "event_timeline", list())
    if (!is.list(states) || !is.list(events)) {
      stop(sprintf("Expected state_timeline and event_timeline arrays in '%s'.", file),
           call. = FALSE)
    }
    if (length(states) > 0L && !is.finite(placement)) {
      stop(sprintf("Timeline data in '%s' requires metadata.subject_placed_at_s.",
                   file), call. = FALSE)
    }

    sessions[[length(sessions) + 1L]] <- tibble::tibble(
      session_id = as.character(session_id),
      task = as.character(task),
      duration_s = duration,
      subject_id = as.character(.behavior_value(subject, "id", NA_character_)),
      species = as.character(.behavior_value(subject, "species", NA_character_)),
      date = as.character(.behavior_value(metadata, "date", NA_character_)),
      time = as.character(.behavior_value(metadata, "time", NA_character_)),
      scorer = as.character(.behavior_value(metadata, "scorer", NA_character_)),
      comments = as.character(.behavior_value(metadata, "comments", NA_character_)),
      video_file = as.character(.behavior_value(metadata, "video_file", NA_character_)),
      source_file = file
    )

    if (length(states) > 0L) {
      state_starts <- vapply(seq_along(states), function(i) {
        .behavior_number(.behavior_value(states[[i]], "start"),
                         sprintf("state_timeline[[%d]].start", i), file,
                         required = TRUE)
      }, numeric(1))
      order_states <- order(state_starts)

      for (ordered_index in seq_along(order_states)) {
        i <- order_states[[ordered_index]]
        entry <- states[[i]]
        start <- state_starts[[i]]
        is_final <- ordered_index == length(order_states)
        raw_end <- .behavior_value(entry, "end")
        end <- if (is_final && is.finite(duration)) {
          placement + duration
        } else {
          .behavior_number(raw_end, sprintf("state_timeline[[%d]].end", i),
                           file, required = TRUE)
        }
        state <- .behavior_value(entry, "state")
        if (!is.character(state) || length(state) != 1L || is.na(state) ||
            !nzchar(state)) {
          stop(sprintf("Expected a non-empty state name in '%s'.", file),
               call. = FALSE)
        }
        if (end <= start) {
          stop(sprintf("State end must be later than its start in '%s' (entry %d).",
                       file, i), call. = FALSE)
        }

        extra <- entry[setdiff(names(entry), c("start", "end", "state"))]
        state_bouts[[length(state_bouts) + 1L]] <- c(
          list(
            session_id = as.character(session_id),
            task = as.character(task),
            start_s = start - placement,
            end_s = end - placement,
            duration_s = end - start,
            state = state
          ),
          extra
        )
      }
    }

    if (length(events) > 0L && !is.finite(placement)) {
      stop(sprintf("Timeline data in '%s' requires metadata.subject_placed_at_s.",
                   file), call. = FALSE)
    }
    for (i in seq_along(events)) {
      entry <- events[[i]]
      start <- .behavior_number(.behavior_value(entry, "start"),
                                sprintf("event_timeline[[%d]].start", i),
                                file, required = TRUE)
      end <- .behavior_number(.behavior_value(entry, "end"),
                              sprintf("event_timeline[[%d]].end", i),
                              file, required = TRUE)
      event <- .behavior_value(entry, "event")
      if (!is.character(event) || length(event) != 1L || is.na(event) ||
          !nzchar(event)) {
        stop(sprintf("Expected a non-empty event name in '%s'.", file),
             call. = FALSE)
      }
      if (end <= start) {
        stop(sprintf("Event end must be later than its start in '%s' (entry %d).",
                     file, i), call. = FALSE)
      }

      event_bouts[[length(event_bouts) + 1L]] <- list(
        session_id = as.character(session_id),
        task = as.character(task),
        start_s = start - placement,
        end_s = end - placement,
        duration_s = end - start,
        event = event
      )
    }
  }

  session_ids <- vapply(sessions, function(session) session$session_id[[1]], character(1))
  if (anyDuplicated(session_ids)) {
    duplicated_ids <- unique(session_ids[duplicated(session_ids)])
    stop(sprintf("Duplicate session_id value(s): %s",
                 paste(duplicated_ids, collapse = ", ")), call. = FALSE)
  }

  list(
    sessions = dplyr::bind_rows(sessions),
    state_bouts = .behavior_bind_rows(
      state_bouts,
      tibble::tibble(session_id = character(), task = character(),
                     start_s = double(), end_s = double(),
                     duration_s = double(), state = character())
    ),
    event_bouts = .behavior_bind_rows(
      event_bouts,
      tibble::tibble(session_id = character(), task = character(),
                     start_s = double(), end_s = double(),
                     duration_s = double(), event = character())
    )
  )
}

.classify_behavior_states <- function(state_bouts, epm_center) {
  if (!requireNamespace("dplyr", quietly = TRUE)) {
    stop("Package 'dplyr' is required. Install the tidyverse.", call. = FALSE)
  }
  state_bouts <- dplyr::arrange(state_bouts, session_id, start_s, end_s)
  state_bouts$analysis_state <- state_bouts$state
  epm_rows <- which(tolower(state_bouts$task) == "elevated_plus" &
                      toupper(state_bouts$state) == "CENTER")

  if (epm_center %in% c("open", "closed")) {
    state_bouts$analysis_state[epm_rows] <- toupper(epm_center)
  } else if (identical(epm_center, "prior")) {
    for (session_id in unique(state_bouts$session_id)) {
      session_rows <- which(state_bouts$session_id == session_id)
      session_rows <- session_rows[
        tolower(state_bouts$task[session_rows]) == "elevated_plus"
      ]
      previous <- "CLOSED"
      for (i in session_rows) {
        if (toupper(state_bouts$state[[i]]) == "CENTER") {
          state_bouts$analysis_state[[i]] <- previous
        } else {
          previous <- state_bouts$state[[i]]
        }
      }
    }
  }

  state_bouts <- dplyr::group_by(state_bouts, session_id)
  state_bouts <- dplyr::mutate(
    state_bouts,
    entered_state = as.integer(
      dplyr::coalesce(analysis_state != dplyr::lag(analysis_state), FALSE)
    )
  )
  dplyr::ungroup(state_bouts)
}

.metric_name <- function(x) {
  if (identical(toupper(x), "STRETCH-ATTEND")) {
    return("stretch.attends")
  }
  x <- tolower(gsub("[^A-Za-z0-9]+", ".", x))
  gsub("^\\.|\\.$", "", x)
}

#' Calculate task metrics using the imported bout tables
#'
#' For EPM, CENTER may remain separate, be classified as OPEN or CLOSED, or
#' inherit the prior non-CENTER state. If the first observed EPM interval is
#' CENTER under the `prior` option, it is classified as CLOSED. The recoded
#' timeline is used for both duration and entry calculations.
#'
#' @param data Result returned by [read_behavior_json()].
#' @param epm_center How to classify EPM CENTER: `center`, `open`, `closed`,
#'   or `prior`.
#' @return A list containing classified `state_bouts`, `event_bouts`, and a
#'   one-row-per-session `summary` tibble.
summarize_behavior <- function(data,
                               epm_center = c("center", "open", "closed", "prior")) {
  epm_center <- match.arg(epm_center)
  if (!is.list(data) ||
      !all(c("sessions", "state_bouts", "event_bouts") %in% names(data))) {
    stop("`data` must be the list returned by read_behavior_json().",
         call. = FALSE)
  }
  if (!requireNamespace("dplyr", quietly = TRUE) ||
      !requireNamespace("tibble", quietly = TRUE)) {
    stop("Packages 'dplyr' and 'tibble' are required. Install the tidyverse.",
         call. = FALSE)
  }

  state_bouts <- .classify_behavior_states(data$state_bouts, epm_center)
  event_bouts <- dplyr::arrange(data$event_bouts, session_id, start_s, end_s)
  prefixes <- c(open_field = "oft", light_dark = "ld", elevated_plus = "epm")
  expected_states <- list(
    open_field = c("CENTER", "EDGE"),
    light_dark = c("LIGHT", "DARK"),
    elevated_plus = if (identical(epm_center, "center")) {
      c("OPEN", "CLOSED", "CENTER")
    } else {
      c("OPEN", "CLOSED")
    }
  )
  expected_events <- list(
    open_field = c("GROOMING", "REARING"),
    light_dark = c("GROOMING", "REARING", "STRETCH-ATTEND"),
    elevated_plus = c("GROOMING", "REARING", "STRETCH-ATTEND")
  )
  summary_rows <- vector("list", nrow(data$sessions))

  for (i in seq_len(nrow(data$sessions))) {
    session <- data$sessions[i, , drop = FALSE]
    session_id <- session$session_id[[1]]
    task <- session$task[[1]]
    prefix <- if (!is.na(task) && task %in% names(prefixes)) {
      prefixes[[task]]
    } else {
      .metric_name(task)
    }
    row <- as.list(session)
    duration <- session$duration_s[[1]]
    row[[paste0(prefix, ".duration")]] <- duration

    state_rows <- state_bouts[state_bouts$session_id == session_id, , drop = FALSE]
    observed_states <- if (nrow(state_rows) > 0L) {
      unique(state_rows$analysis_state)
    } else {
      character()
    }
    task_states <- if (!is.na(task) && task %in% names(expected_states)) {
      expected_states[[task]]
    } else {
      character()
    }
    state_names <- unique(c(task_states, observed_states))

    for (state_name in state_names) {
      state_key <- .metric_name(state_name)
      matching <- state_rows$analysis_state == state_name
      matching[is.na(matching)] <- FALSE
      state_time <- sum(state_rows$duration_s[matching], na.rm = TRUE)
      state_entries <- sum(state_rows$entered_state[matching], na.rm = TRUE)
      row[[paste0(prefix, ".", state_key, ".entries")]] <- state_entries
      row[[paste0(prefix, ".", state_key, ".time")]] <- state_time
      row[[paste0(prefix, ".", state_key, ".pct")]] <-
        if (is.finite(duration) && duration > 0) 100 * state_time / duration else NA_real_
    }

    if (identical(task, "open_field")) {
      center_rows <- state_rows[
        toupper(state_rows$state) == "CENTER", , drop = FALSE
      ]
      crossings <- if ("full_crossing" %in% names(center_rows)) {
        sum(center_rows$full_crossing %in% TRUE, na.rm = TRUE)
      } else {
        0L
      }
      row[["oft.center.crossings"]] <- crossings
    }

    event_rows <- event_bouts[event_bouts$session_id == session_id, , drop = FALSE]
    observed_events <- if (nrow(event_rows) > 0L) unique(event_rows$event) else character()
    task_events <- if (!is.na(task) && task %in% names(expected_events)) {
      expected_events[[task]]
    } else {
      character()
    }
    for (event_name in unique(c(task_events, observed_events))) {
      event_key <- .metric_name(event_name)
      matching <- event_rows$event == event_name
      matching[is.na(matching)] <- FALSE
      row[[paste0(prefix, ".", event_key, ".bouts")]] <- sum(matching)
      row[[paste0(prefix, ".", event_key, ".time")]] <-
        sum(event_rows$duration_s[matching], na.rm = TRUE)
      if (toupper(event_name) %in% c("REARING", "STRETCH-ATTEND")) {
        row[[paste0(prefix, ".", event_key)]] <- sum(matching)
      }
    }

    grooming_time <- row[[paste0(prefix, ".grooming.time")]]
    row[[paste0(prefix, ".grooming.pct")]] <-
      if (is.finite(duration) && duration > 0) {
        100 * grooming_time / duration
      } else {
        NA_real_
      }

    if (identical(task, "light_dark")) {
      light_rows <- state_rows[
        toupper(state_rows$analysis_state) == "LIGHT", , drop = FALSE
      ]
      row[["ld.latency"]] <- if (nrow(light_rows) > 0L) {
        min(light_rows$start_s)
      } else {
        NA_real_
      }
    }
    summary_rows[[i]] <- row
  }

  list(
    state_bouts = state_bouts,
    event_bouts = event_bouts,
    summary = dplyr::bind_rows(summary_rows)
  )
}
