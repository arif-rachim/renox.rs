[
  {"description": "an owner opens the back office", "principal": {"type": "User", "id": "u_owner", "roles": ["owner"], "attrs": {"org": "org_dubai"}}, "action": "settings.read", "expected": "allow"},
  {"description": "an owner with a recent second factor changes the branding", "principal": {"type": "User", "id": "u_owner", "roles": ["owner"], "attrs": {"org": "org_dubai", "mfa_verified": true}}, "action": "settings.write", "expected": "allow"},
  {"description": "an owner without the second factor does not", "principal": {"type": "User", "id": "u_owner", "roles": ["owner"], "attrs": {"org": "org_dubai", "mfa_verified": false}}, "action": "settings.write", "expected": "deny"},
  {"description": "an owner with a recent second factor manages the people", "principal": {"type": "User", "id": "u_owner", "roles": ["owner"], "attrs": {"org": "org_dubai", "mfa_verified": true}}, "action": "user.manage", "expected": "allow"},
  {"description": "an owner without the second factor does not", "principal": {"type": "User", "id": "u_owner", "roles": ["owner"], "attrs": {"org": "org_dubai", "mfa_verified": false}}, "action": "user.manage", "expected": "deny"},
  {"description": "a branch manager does not open the back office", "principal": {"type": "User", "id": "u_dxb_manager", "roles": ["branch_manager"], "attrs": {"org": "org_dubai"}}, "action": "settings.read", "expected": "deny"},
  {"description": "a dispatcher does not open it", "principal": {"type": "User", "id": "u_dxb_dispatcher", "roles": ["dispatcher"], "attrs": {"org": "org_dubai"}}, "action": "settings.read", "expected": "deny"},
  {"description": "a dispatcher does not change the branding, even with a second factor", "principal": {"type": "User", "id": "u_dxb_dispatcher", "roles": ["dispatcher"], "attrs": {"org": "org_dubai", "mfa_verified": true}}, "action": "settings.write", "expected": "deny"},
  {"description": "an accountant does not manage the people", "principal": {"type": "User", "id": "u_dxb_accountant", "roles": ["accountant"], "attrs": {"org": "org_dubai", "mfa_verified": true}}, "action": "user.manage", "expected": "deny"},
  {"description": "a technician does not open it", "principal": {"type": "User", "id": "u_dxb_ali", "roles": ["technician"], "attrs": {"org": "org_dubai"}}, "action": "settings.read", "expected": "deny"}
]
