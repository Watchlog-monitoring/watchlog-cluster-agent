const fs = require('fs');
const axios = require('axios');
const https = require('https');

// Collect system metrics from the host

async function collectKubernetesMetrics(watchlogServerSocket) {
  try {
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8');

    const httpsAgent = new https.Agent({ ca });
    const baseURL = 'https://kubernetes.default.svc';

    const headers = {
      Authorization: `Bearer ${token}`,
    };

    const [nodesRes, podsRes, nodeMetricsRes, podMetricsRes] = await Promise.all([
      axios.get(`${baseURL}/api/v1/nodes`, { httpsAgent, headers }),
      axios.get(`${baseURL}/api/v1/pods`, { httpsAgent, headers }),
      axios.get(`${baseURL}/apis/metrics.k8s.io/v1beta1/nodes`, { httpsAgent, headers }),
      axios.get(`${baseURL}/apis/metrics.k8s.io/v1beta1/pods`, { httpsAgent, headers }),
    ]);

    const nodes = nodesRes.data.items || [];
    const pods = podsRes.data.items || [];
    const nodeMetrics = nodeMetricsRes.data.items || [];
    const podMetrics = podMetricsRes.data.items || [];

    // Create a map for pod metrics for faster lookup
    const podMetricsMap = {};
    podMetrics.forEach(pod => {
      podMetricsMap[`${pod.metadata.namespace}/${pod.metadata.name}`] = pod;
    });

    // Process pods and create comprehensive pod objects
    const podObjects = pods.map(pod => {
      const podKey = `${pod.metadata.namespace}/${pod.metadata.name}`;
      const metrics = podMetricsMap[podKey] || {};
      const containers = {};

      // Process container metrics
      (metrics.containers || []).forEach(container => {
        containers[container.name] = {
          cpu: {
            usageNanoCores: parseCpu(container.usage?.cpu),
            requests: parseCpu(pod.spec.containers.find(c => c.name === container.name)?.resources?.requests?.cpu),
            limits: parseCpu(pod.spec.containers.find(c => c.name === container.name)?.resources?.limits?.cpu),
          },
          memory: {
            usageBytes: parseMemory(container.usage?.memory),
            requests: parseMemory(pod.spec.containers.find(c => c.name === container.name)?.resources?.requests?.memory),
            limits: parseMemory(pod.spec.containers.find(c => c.name === container.name)?.resources?.limits?.memory),
          }
        };
      });

      // Calculate total pod resource usage
      const totalCpu = Object.values(containers).reduce((sum, c) => sum + (c.cpu.usageNanoCores || 0), 0);
      const totalMemory = Object.values(containers).reduce((sum, c) => sum + (c.memory.usageBytes || 0), 0);

      return {
        metadata: {
          name: pod.metadata.name,
          namespace: pod.metadata.namespace,
          nodeName: pod.spec.nodeName,
          creationTimestamp: pod.metadata.creationTimestamp,
          labels: pod.metadata.labels || {},
          annotations: pod.metadata.annotations || {},
        },
        status: {
          phase: pod.status.phase,
          conditions: pod.status.conditions || [],
          startTime: pod.status.startTime,
          podIP: pod.status.podIP,
          hostIP: pod.status.hostIP,
          qosClass: pod.status.qosClass,
        },
        containers: containers,
        resources: {
          cpu: {
            totalUsageNanoCores: totalCpu,
            requests: Object.values(containers).reduce((sum, c) => sum + (c.cpu.requests || 0), 0),
            limits: Object.values(containers).reduce((sum, c) => sum + (c.cpu.limits || 0), 0),
          },
          memory: {
            totalUsageBytes: totalMemory,
            requests: Object.values(containers).reduce((sum, c) => sum + (c.memory.requests || 0), 0),
            limits: Object.values(containers).reduce((sum, c) => sum + (c.memory.limits || 0), 0),
          }
        },
        readyContainers: pod.status.containerStatuses?.filter(c => c.ready).length || 0,
        totalContainers: pod.status.containerStatuses?.length || 0,
        restarts: pod.status.containerStatuses?.reduce((sum, c) => sum + (c.restartCount || 0), 0) || 0,
        age: calculateAge(pod.metadata.creationTimestamp),
      };
    });

    // Process node metrics
    const nodeObjects = nodes.map(node => {
      const metrics = nodeMetrics.find(n => n.metadata.name === node.metadata.name) || {};
      const nodeConditions = {};

      (node.status.conditions || []).forEach(condition => {
        nodeConditions[condition.type] = {
          status: condition.status,
          lastHeartbeatTime: condition.lastHeartbeatTime,
          lastTransitionTime: condition.lastTransitionTime,
          reason: condition.reason,
          message: condition.message,
        };
      });

      return {
        metadata: {
          name: node.metadata.name,
          labels: node.metadata.labels || {},
          annotations: node.metadata.annotations || {},
          creationTimestamp: node.metadata.creationTimestamp,
        },
        status: {
          capacity: {
            cpu: parseCpu(node.status.capacity?.cpu),
            memory: parseMemory(node.status.capacity?.memory),
            pods: parseInt(node.status.capacity?.pods) || 0,
          },
          allocatable: {
            cpu: parseCpu(node.status.allocatable?.cpu),
            memory: parseMemory(node.status.allocatable?.memory),
            pods: parseInt(node.status.allocatable?.pods) || 0,
          },
          conditions: nodeConditions,
          nodeInfo: node.status.nodeInfo,
        },
        resources: {
          cpu: {
            usageNanoCores: parseCpu(metrics.usage?.cpu),
            capacity: parseCpu(node.status.capacity?.cpu),
          },
          memory: {
            usageBytes: parseMemory(metrics.usage?.memory),
            capacity: parseMemory(node.status.capacity?.memory),
          },
        },
        pods: {
          running: podObjects.filter(p => p.metadata.nodeName === node.metadata.name && p.status.phase === 'Running').length,
          total: podObjects.filter(p => p.metadata.nodeName === node.metadata.name).length,
        },
        age: calculateAge(node.metadata.creationTimestamp),
      };
    });

    const result = {
      cluster : process.env.WATCHLOG_CLUSTER_NAME ? process.env.WATCHLOG_CLUSTER_NAME : "default-cluster",
      timestamp: new Date().toISOString(),
      nodes: nodeObjects,
      pods: podObjects,
    };

    watchlogServerSocket.emit('kubernetesMetrics', result);
  } catch (err) {
    console.error('❌ Error collecting Kubernetes metrics:', err.message);
  }
}

// Helper functions
function parseCpu(cpu) {
  if (!cpu) return null;
  if (cpu.endsWith('n')) return parseInt(cpu.replace('n', ''));
  if (cpu.endsWith('m')) return parseFloat(cpu.replace('m', '')) * 1000000;
  return parseFloat(cpu) * 1000000000;
}

function parseMemory(mem) {
  if (!mem) return null;
  if (mem.endsWith('Ki')) return parseInt(mem.replace('Ki', '')) * 1024;
  if (mem.endsWith('Mi')) return parseInt(mem.replace('Mi', '')) * 1024 * 1024;
  if (mem.endsWith('Gi')) return parseInt(mem.replace('Gi', '')) * 1024 * 1024 * 1024;
  return parseInt(mem);
}

function calculateAge(creationTimestamp) {
  if (!creationTimestamp) return null;
  const created = new Date(creationTimestamp);
  const now = new Date();
  const diff = now - created;
  return {
    seconds: Math.floor(diff / 1000),
    humanReadable: formatDuration(diff),
  };
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}



module.exports = {
  collectKubernetesMetrics
};