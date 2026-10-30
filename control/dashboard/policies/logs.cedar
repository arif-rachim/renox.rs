// The live Logs topic (#307; ops.md section 18, "Authorization: topics as
// Cedar resources"). The dashboard has no auth module: its users sign in
// with their own control-API token, so the platform principal is anonymous.
// Only the dashboard's own SSE handler subscribes, and only after the
// control API has answered the signed-in user's token for that app (a member
// of the app's tenant); the topic carries 128 random bits per connection
// (functions/sse/logs.ts). Anything else is refused: no policy permits
// another topic.
permit (principal, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "logs:*:*" && resource.segments.contains("logs") };
