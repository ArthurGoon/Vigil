CREATE OR REPLACE VIEW analytics_funnel_daily AS
SELECT
  date_trunc('day', occurred_at) AS day,
  count(*) FILTER (WHERE name = 'page_view') AS page_views,
  count(*) FILTER (WHERE name = 'signup_started') AS signup_started,
  count(*) FILTER (WHERE name = 'signup_completed') AS signup_completed,
  count(*) FILTER (WHERE name = 'watch_created') AS watches_created,
  count(*) FILTER (WHERE name = 'watch_check_succeeded') AS checks_ok,
  count(*) FILTER (WHERE name = 'watch_change_detected') AS changes_detected
FROM events
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW analytics_time_on_page AS
SELECT
  date_trunc('day', occurred_at) AS day,
  props->>'path' AS path,
  count(*) AS leaves,
  avg(NULLIF(props->>'duration_ms', '')::numeric) AS avg_duration_ms,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY NULLIF(props->>'duration_ms', '')::numeric
  ) AS p50_duration_ms
FROM events
WHERE name = 'page_leave'
GROUP BY 1, 2
ORDER BY 1 DESC, leaves DESC;
