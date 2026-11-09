[
  { "description": "an owner views the reports", "principal": { "type": "User", "id": "u_owner", "roles": ["owner"], "attrs": { "org": "org_dubai" } }, "action": "reports.view", "expected": "allow" },
  { "description": "an owner exports them", "principal": { "type": "User", "id": "u_owner", "roles": ["owner"], "attrs": { "org": "org_dubai" } }, "action": "reports.export", "expected": "allow" },
  { "description": "an accountant views the reports", "principal": { "type": "User", "id": "u_dxb_accountant", "roles": ["accountant"], "attrs": { "org": "org_dubai" } }, "action": "reports.view", "expected": "allow" },
  { "description": "an accountant exports them", "principal": { "type": "User", "id": "u_dxb_accountant", "roles": ["accountant"], "attrs": { "org": "org_dubai" } }, "action": "reports.export", "expected": "allow" },
  { "description": "a dispatcher does not view the reports", "principal": { "type": "User", "id": "u_dxb_dispatcher", "roles": ["dispatcher"], "attrs": { "org": "org_dubai" } }, "action": "reports.view", "expected": "deny" },
  { "description": "a dispatcher does not export them", "principal": { "type": "User", "id": "u_dxb_dispatcher", "roles": ["dispatcher"], "attrs": { "org": "org_dubai" } }, "action": "reports.export", "expected": "deny" },
  { "description": "a branch manager does not view the company's reports", "principal": { "type": "User", "id": "u_dxb_manager", "roles": ["branch_manager"], "attrs": { "org": "org_dubai" } }, "action": "reports.view", "expected": "deny" },
  { "description": "a technician does not view the reports", "principal": { "type": "User", "id": "u_dxb_ali", "roles": ["technician"], "attrs": { "org": "org_dubai" } }, "action": "reports.view", "expected": "deny" }
]
