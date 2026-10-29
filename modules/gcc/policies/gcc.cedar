// gcc's data is public: anyone may read areas and run the checks (files
// only in F4; evaluated from F5).
permit (principal, action == Action::"gcc.read", resource);
