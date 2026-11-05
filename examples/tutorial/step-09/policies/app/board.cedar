// Chapter 7: the board's policies. `principal.org` is the session's active
// team; the org module puts it on the principal.

// The page's guard: any signed-in user opens /board.
permit (principal is Renox::User, action == Renox::Action::"board.view", resource == Renox::Action::"board.view");

// Members of the team add and tick off its tasks, and nobody else.
permit (principal is Renox::User, action == Renox::Action::"task.edit", resource is App::Task)
when { principal has org && resource.team_id == principal.org };

// Removing is for the team too; the action also asks for an admin or an
// owner (chapter 7 explains why that check is not here).
permit (principal is Renox::User, action == Renox::Action::"task.delete", resource is App::Task)
when { principal has org && resource.team_id == principal.org };

// Chapter 8: the live feed of your own team only.
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "board:*" && principal has org && resource.segments.contains(principal.org) };
