library(shiny)

# Simple Shiny wrapper that serves the static site from www/
# Put the static build into the `www/` folder and deploy this app to Posit Connect.

ui <- fluidPage(
  tags$iframe(src = "index.html", style = "width:100%;height:900px;border:none;")
)

server <- function(input, output, session) {
}

shinyApp(ui = ui, server = server)
