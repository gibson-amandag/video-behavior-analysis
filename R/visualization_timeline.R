# visualization_timeline.R
#
# Helpers for visualizing state and event timelines.
# Produces ggplot2 objects that can be customised or saved by the caller.
#
# Dependencies: ggplot2, dplyr, tibble

library(ggplot2)
library(dplyr)
library(tibble)

# ---------------------------------------------------------------------------
# plot_timeline()
# ---------------------------------------------------------------------------
#' Plot a combined state + event timeline for a single session.
#'
#' States are rendered as filled rectangles spanning the time axis.
#' Events are rendered as thinner colored rectangles below the states.
#'
#' @param scoring List. Output of read_scoring_json().
#' @param title Character. Optional plot title. Defaults to session_id.
#' @return A ggplot2 object.
plot_timeline <- function(scoring, title = NULL) {
  state_df <- scoring$state_timeline
  event_df <- scoring$event_timeline

  if (is.null(title)) title <- scoring$session_id

  # Assign a y-band to states (y = 1) and events (y = 0)
  state_plot <- state_df %>%
    dplyr::mutate(
      ymin  = 0.55,
      ymax  = 1.0,
      label = .data$state,
      layer = "State"
    )

  if (nrow(event_df) > 0) {
    event_plot <- event_df %>%
      dplyr::mutate(
        ymin  = 0.0,
        ymax  = 0.45,
        label = .data$event,
        layer = "Event"
      )
    plot_df <- dplyr::bind_rows(state_plot, event_plot)
  } else {
    plot_df <- state_plot
  }

  ggplot2::ggplot(plot_df,
    ggplot2::aes(
      xmin  = .data$start,
      xmax  = .data$end,
      ymin  = .data$ymin,
      ymax  = .data$ymax,
      fill  = .data$label
    )
  ) +
    ggplot2::geom_rect(colour = "white", linewidth = 0.3) +
    ggplot2::scale_x_continuous(
      name   = "Time (s)",
      limits = c(0, scoring$duration_s),
      expand = c(0, 0)
    ) +
    ggplot2::scale_y_continuous(
      breaks = c(0.225, 0.775),
      labels = c("Events", "States"),
      limits = c(0, 1),
      expand = c(0, 0)
    ) +
    ggplot2::labs(title = title, fill = NULL) +
    ggplot2::theme_minimal(base_size = 12) +
    ggplot2::theme(
      panel.grid.major.y = ggplot2::element_blank(),
      panel.grid.minor   = ggplot2::element_blank(),
      legend.position    = "bottom"
    )
}

# ---------------------------------------------------------------------------
# plot_state_proportions()
# ---------------------------------------------------------------------------
#' Bar chart of time spent in each state across one or more sessions.
#'
#' @param scoring_list List of scoring objects (each from read_scoring_json()).
#'   Can also be a single scoring object.
#' @return A ggplot2 object.
plot_state_proportions <- function(scoring_list) {
  if (!is.list(scoring_list[[1]])) {
    scoring_list <- list(scoring_list)
  }

  rows <- lapply(scoring_list, function(s) {
    s$state_timeline %>%
      dplyr::group_by(.data$state) %>%
      dplyr::summarise(total_s = sum(.data$duration), .groups = "drop") %>%
      dplyr::mutate(session_id = s$session_id)
  })

  plot_df <- dplyr::bind_rows(rows)

  ggplot2::ggplot(plot_df,
    ggplot2::aes(
      x    = .data$session_id,
      y    = .data$total_s,
      fill = .data$state
    )
  ) +
    ggplot2::geom_col(position = "stack") +
    ggplot2::labs(
      x    = "Session",
      y    = "Time (s)",
      fill = "State",
      title = "Time in each state by session"
    ) +
    ggplot2::theme_minimal(base_size = 12) +
    ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1))
}

# ---------------------------------------------------------------------------
# plot_event_counts()
# ---------------------------------------------------------------------------
#' Bar chart of event counts across one or more sessions.
#'
#' @param scoring_list List of scoring objects (each from read_scoring_json()).
#'   Can also be a single scoring object.
#' @return A ggplot2 object.
plot_event_counts <- function(scoring_list) {
  if (!is.list(scoring_list[[1]])) {
    scoring_list <- list(scoring_list)
  }

  rows <- lapply(scoring_list, function(s) {
    if (nrow(s$event_timeline) == 0) {
      return(tibble::tibble(event = character(), n = integer(),
                            session_id = character()))
    }
    s$event_timeline %>%
      dplyr::count(.data$event) %>%
      dplyr::mutate(session_id = s$session_id)
  })

  plot_df <- dplyr::bind_rows(rows)

  ggplot2::ggplot(plot_df,
    ggplot2::aes(
      x    = .data$session_id,
      y    = .data$n,
      fill = .data$event
    )
  ) +
    ggplot2::geom_col(position = "dodge") +
    ggplot2::labs(
      x     = "Session",
      y     = "Count",
      fill  = "Event",
      title = "Event counts by session"
    ) +
    ggplot2::theme_minimal(base_size = 12) +
    ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1))
}
