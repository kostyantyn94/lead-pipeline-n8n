-- Pipeline metrics. Run: docker compose exec -T postgres psql -U n8n -d leads -f /sql/metrics.sql
\x on
select * from v_metrics;
\x off
select decision, decided_by, count(*) as leads, round(avg(score), 3) as avg_score
from leads group by 1, 2 order by 1, 2;
select rule_id, r.kind, r.pattern, count(*) as leads
from leads l join rules r on r.id = l.rule_id group by 1, 2, 3 order by 4 desc;
