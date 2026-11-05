-- Sample tasks. `renox test` loads seeds/*.sql into each test's database.
insert into app__tasks (title, done, created_at) values
  ('Install the renox CLI', 1, 0),
  ('Write the first page', 0, 0),
  ('Invite the team', 0, 0);
