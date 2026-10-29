// The 2fa module's own pages (#287): a signed-in user manages their own
// second factors; the pages work on the session's user only.
permit (principal is Renox::User, action == Renox::Action::"twofa.manage", resource == Renox::Action::"twofa.manage");
