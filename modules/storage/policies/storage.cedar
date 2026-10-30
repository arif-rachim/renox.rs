// Default policy of the storage module (#332): an admin browses and deletes
// any owner's files. Everyone else sees and manages their own folder only
// (the page's owner is the signed-in user). storage.manage is sensitive.
permit (principal in Renox::Role::"admin", action == Renox::Action::"storage.manage", resource);
