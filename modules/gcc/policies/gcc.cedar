// gcc's data is public: anyone may read areas and run the checks (files
// only in F4; evaluated from F5, in the platform namespace).
permit (principal, action == Renox::Action::"gcc.read", resource);
