// The notifications module's topic (#289; ops.md section 18, "Authorization:
// topics as Cedar resources"): a signed-in user may subscribe only to their
// own `notif:user:<id>`. User ids are auth's 32 hex digits, so no id equals
// the segments `notif` or `user`.
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "notif:user:*" && resource.segments.contains(principal.id) };
