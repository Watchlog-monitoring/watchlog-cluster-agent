/**
 * Workload collectors: deployments, statefulsets, daemonsets, replicasets,
 * jobs, cronjobs. Each is fetched independently (soft) so a missing API group
 * never aborts the snapshot.
 */
const { calculateAge } = require('../units');

function common(obj, kind, now) {
  return {
    uid: obj.metadata.uid,
    kind,
    name: obj.metadata.name,
    namespace: obj.metadata.namespace,
    labels: obj.metadata.labels || {},
    annotations: obj.metadata.annotations || {},
    selector: (obj.spec && obj.spec.selector && obj.spec.selector.matchLabels) || {},
    ownerReferences: (obj.metadata.ownerReferences || []).map((o) => ({
      kind: o.kind,
      name: o.name,
      uid: o.uid,
    })),
    createdAt: obj.metadata.creationTimestamp,
    age: calculateAge(obj.metadata.creationTimestamp, now),
  };
}

function mapDeploymentLike(items, kind, now) {
  return items.map((d) => {
    const s = d.status || {};
    const spec = d.spec || {};
    return {
      ...common(d, kind, now),
      strategy: spec.strategy && spec.strategy.type,
      replicas: {
        desired: spec.replicas != null ? spec.replicas : s.replicas || 0,
        ready: s.readyReplicas || 0,
        available: s.availableReplicas || 0,
        updated: s.updatedReplicas || 0,
        unavailable: s.unavailableReplicas || 0,
      },
    };
  });
}

function mapDaemonSet(items, now) {
  return items.map((d) => {
    const s = d.status || {};
    return {
      ...common(d, 'daemonset', now),
      replicas: {
        desired: s.desiredNumberScheduled || 0,
        ready: s.numberReady || 0,
        available: s.numberAvailable || 0,
        updated: s.updatedNumberScheduled || 0,
        unavailable: s.numberUnavailable || 0,
      },
    };
  });
}

function mapJob(items, now) {
  return items.map((j) => {
    const s = j.status || {};
    const spec = j.spec || {};
    return {
      ...common(j, 'job', now),
      job: {
        completions: spec.completions,
        succeeded: s.succeeded || 0,
        failed: s.failed || 0,
        active: s.active || 0,
        startTime: s.startTime,
        completionTime: s.completionTime,
      },
    };
  });
}

function mapCronJob(items, now) {
  return items.map((c) => {
    const s = c.status || {};
    const spec = c.spec || {};
    return {
      ...common(c, 'cronjob', now),
      cronJob: {
        schedule: spec.schedule,
        suspend: !!spec.suspend,
        concurrencyPolicy: spec.concurrencyPolicy,
        lastScheduleTime: s.lastScheduleTime,
        activeJobs: (s.active || []).map((a) => a.uid),
      },
    };
  });
}

async function collectWorkloads(client, now) {
  const [dep, sts, ds, rs, jobs, cron] = await Promise.all([
    client.softListAll('/apis/apps/v1/deployments', { pageSize: 200 }),
    client.softListAll('/apis/apps/v1/statefulsets', { pageSize: 200 }),
    client.softListAll('/apis/apps/v1/daemonsets', { pageSize: 200 }),
    client.softListAll('/apis/apps/v1/replicasets', { pageSize: 500 }),
    client.softListAll('/apis/batch/v1/jobs', { pageSize: 200 }),
    client.softListAll('/apis/batch/v1/cronjobs', { pageSize: 200 }),
  ]);

  const errors = [];
  const pair = (res, kindLabel) => {
    if (res.error) errors.push({ kind: kindLabel, ...res.error });
  };
  pair(dep, 'deployments');
  pair(sts, 'statefulSets');
  pair(ds, 'daemonSets');
  pair(rs, 'replicaSets');
  pair(jobs, 'jobs');
  pair(cron, 'cronJobs');

  return {
    workloads: {
      deployments: mapDeploymentLike(dep.items, 'deployment', now),
      statefulSets: mapDeploymentLike(sts.items, 'statefulset', now),
      daemonSets: mapDaemonSet(ds.items, now),
      replicaSets: mapDeploymentLike(rs.items, 'replicaset', now),
      jobs: mapJob(jobs.items, now),
      cronJobs: mapCronJob(cron.items, now),
    },
    errors,
  };
}

module.exports = { collectWorkloads };
