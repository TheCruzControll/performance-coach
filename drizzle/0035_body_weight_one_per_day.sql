-- One weigh-in per owner per day: keep each day's latest (created_at, then id), as saveBody did.
DELETE FROM body_weight_entries b USING (
  SELECT id, row_number() OVER (PARTITION BY owner_id, measured_on ORDER BY created_at DESC, id DESC) AS n
  FROM body_weight_entries) d
WHERE b.id = d.id AND d.n > 1;
