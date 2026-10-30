// Default policies of the reports module (#333): admins and the finance role
// read and export the reports. reports.export is sensitive (every export is
// an audit row): it carries the period's customers and amounts out of the app.
permit (principal in Renox::Role::"admin", action in [Renox::Action::"reports.view", Renox::Action::"reports.export"], resource);
permit (principal in Renox::Role::"finance", action in [Renox::Action::"reports.view", Renox::Action::"reports.export"], resource);
