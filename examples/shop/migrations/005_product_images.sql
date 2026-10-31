-- Product images through the storage module (#332): `image` now holds the
-- stored file's key (`storage/products/<category>.png`), and the stored
-- width and height let `<x-image>` emit its dimensions without a storage
-- call per render. Null until the seed has stored the image.
alter table app__products add column image_width integer check (image_width is null or image_width > 0);
alter table app__products add column image_height integer check (image_height is null or image_height > 0);
