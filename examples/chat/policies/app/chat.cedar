// The routes' guard (#282): signed-in users only, checked by the cell
// before the page loader or the socket's `open` runs.
permit (principal is Renox::User, action == Renox::Action::"room.enter", resource == Renox::Action::"room.enter");

// Who may join a room (#282). `member` is computed by the WebSocket route
// from app__members ("yes"/"no"), `private` is the room's column.
permit (principal is Renox::User, action == Renox::Action::"room.join", resource is App::Room)
when { resource.private == 0 || resource.member == "yes" };

// The room topics: a signed-in user may subscribe to `room:*`; the route
// subscribes only after `room.join` allowed it.
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "room:*" };
