[
  { "description": "a dispatcher reads contracts", "principal": { "type": "User", "id": "u_dxb_dispatcher", "roles": ["dispatcher"], "attrs": { "org": "org_dubai" } }, "action": "contract.read", "expected": "allow" },
  { "description": "a dispatcher writes contracts: contracts are the dispatcher's and above", "principal": { "type": "User", "id": "u_dxb_dispatcher", "roles": ["dispatcher"], "attrs": { "org": "org_dubai" } }, "action": "contract.write", "expected": "allow" },
  { "description": "a branch manager writes contracts", "principal": { "type": "User", "id": "u_dxb_manager", "roles": ["branch_manager"], "attrs": { "org": "org_dubai" } }, "action": "contract.write", "expected": "allow" },
  { "description": "an owner writes contracts", "principal": { "type": "User", "id": "u_owner", "roles": ["owner"], "attrs": { "org": "org_dubai" } }, "action": "contract.write", "expected": "allow" },
  { "description": "an accountant reads contracts but does not write them", "principal": { "type": "User", "id": "u_dxb_accountant", "roles": ["accountant"], "attrs": { "org": "org_dubai" } }, "action": "contract.read", "expected": "allow" },
  { "description": "an accountant does not write contracts", "principal": { "type": "User", "id": "u_dxb_accountant", "roles": ["accountant"], "attrs": { "org": "org_dubai" } }, "action": "contract.write", "expected": "deny" },
  { "description": "a technician does not read contracts", "principal": { "type": "User", "id": "u_dxb_ali", "roles": ["technician"], "attrs": { "org": "org_dubai" } }, "action": "contract.read", "expected": "deny" }
]
