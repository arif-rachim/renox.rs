[
  { "description": "a customer may view the portal", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "portal.view", "expected": "allow" },
  { "description": "a customer may book", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "portal.book", "expected": "allow" },
  { "description": "a customer may change a visit", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "portal.change", "expected": "allow" },
  { "description": "a customer does not read customers", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "customer.read", "expected": "deny" },
  { "description": "a customer does not read jobs", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "job.read", "expected": "deny" },
  { "description": "a customer does not read invoices", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "invoice.read", "expected": "deny" },
  { "description": "a customer does not open the back office", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "settings.read", "expected": "deny" },
  { "description": "a customer does not read reports", "principal": { "type": "User", "id": "u_cust", "roles": ["customer"], "attrs": {} }, "action": "report.view", "expected": "deny" },
  { "description": "a customer who also holds a staff role (a mistake) is still refused the staff action", "principal": { "type": "User", "id": "u_cust", "roles": ["customer", "dispatcher"], "attrs": { "org": "org_dubai" } }, "action": "job.read", "expected": "deny" },
  { "description": "a dispatcher does not hold the portal actions", "principal": { "type": "User", "id": "u_dxb_dispatcher", "roles": ["dispatcher"], "attrs": { "org": "org_dubai" } }, "action": "portal.view", "expected": "deny" }
]
