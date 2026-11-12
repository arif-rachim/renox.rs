// A reset of a user's second factor (twofa.reset, sensitive) is for support only.
permit (principal is Renox::User, action == Renox::Action::"twofa.reset", resource is Twofa::User)
when { principal in Renox::Role::"support" };
