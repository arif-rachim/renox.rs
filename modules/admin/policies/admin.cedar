// Default policy of the admin module (#335): the admin role opens the back
// office and manages who else holds it. admin.users is sensitive: every
// grant and revoke decision is audited.
permit (principal in Renox::Role::"admin", action in [Renox::Action::"admin.access", Renox::Action::"admin.users"], resource);
