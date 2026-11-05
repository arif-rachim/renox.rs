// Chapter 8: when the server says the board changed, fetch the tasks
// fragment again, so every member sees it through their own permissions.
document.addEventListener("DOMContentLoaded", () => {
  const tasks = document.getElementById("tasks");
  if (tasks === null || !tasks.dataset.live) return;
  const feed = new EventSource(tasks.dataset.live);
  feed.addEventListener("message", () => {
    htmx.ajax("GET", location.pathname, { target: "#tasks", swap: "outerHTML" });
  });
});
