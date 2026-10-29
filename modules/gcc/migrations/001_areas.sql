-- Emirates (ISO 3166-2:AE) and areas, English and Arabic names. `makani`:
-- the area is in Dubai, where Makani numbers are the geographic address.
create table gcc__areas (
  id integer primary key,
  emirate text not null check (emirate in ('AE-AZ', 'AE-DU', 'AE-SH', 'AE-AJ', 'AE-UQ', 'AE-RK', 'AE-FU')),
  name_en text not null collate nocase,
  name_ar text not null collate nocase,
  makani integer not null default 0 check (makani in (0, 1))
);
-- `findAreas` is one prefix query on each of these (LIKE 'x%' on a NOCASE index).
create index gcc__areas_name_en on gcc__areas (name_en);
create index gcc__areas_name_ar on gcc__areas (name_ar);
create index gcc__areas_emirate on gcc__areas (emirate, name_en);

create view gcc__public_areas_v1 as select id, emirate, name_en, name_ar, makani from gcc__areas;
