-- A visit's part line can pick a stocked part (#814, wave D): `part_id` is the part of app__parts (null for a free-text
-- line, which stays allowed) and `stock_move_id` the `out` move that took it from the branch's stock (lib/stock.ts;
-- null for free text). The line keeps `description` and `unit_price_fils` as they were taken (the part's English name and
-- selling price at that time); the invoice and the report read the name in the document's language from the part.
alter table app__visit_parts add column part_id text references app__parts (id);
alter table app__visit_parts add column stock_move_id text;
create index app__visit_parts_part on app__visit_parts (part_id);
