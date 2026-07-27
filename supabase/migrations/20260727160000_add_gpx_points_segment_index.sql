-- 优化旅程详情页 gpx_points 加载速度
-- 为按 segment 排序查询 gpx_points 提供索引支持
CREATE INDEX IF NOT EXISTS idx_gpx_points_segment_point_index
ON public.gpx_points (segment_id, point_index);
