// Default policies of the booking module (#334): an admin manages services,
// staff and every booking; a staff member sees the calendar. Customers see
// only their own bookings (the pages filter by the principal). The live
// calendar topic is calendar:<staff_id>; the SSE route subscribes a staff
// member to their own only, and only the staff and admin roles subscribe.
permit (principal in Renox::Role::"admin", action in [Renox::Action::"booking.manage", Renox::Action::"booking.view_calendar"], resource);
permit (principal in Renox::Role::"staff", action == Renox::Action::"booking.view_calendar", resource);
permit (principal in Renox::Role::"staff", action == Renox::Action::"realtime.subscribe", resource is Renox::Topic) when { resource.name like "calendar:*" };
permit (principal in Renox::Role::"admin", action == Renox::Action::"realtime.subscribe", resource is Renox::Topic) when { resource.name like "calendar:*" };
