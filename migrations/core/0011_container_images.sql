-- Container image and instance per agent (task 014). SPEC-containers 0.
-- container_image: 'debian' (stock), 'desktop' (ours) or a custom image name from wrangler.jsonc.
-- container_instance: NULL = the image's default (debian lite, desktop standard-1, custom basic).
ALTER TABLE agents ADD COLUMN container_image TEXT NOT NULL DEFAULT 'debian';
ALTER TABLE agents ADD COLUMN container_instance TEXT;
