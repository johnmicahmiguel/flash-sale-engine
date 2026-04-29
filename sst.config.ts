/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'flash-sale-engine',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: { region: 'ap-southeast-2' },
      },
    };
  },

  async run() {
    const dnsZone = 'flashsale.johnmicahmiguel.com';
    const webDomain = dnsZone;
    const apiDomain = `api.${dnsZone}`;

    const vpc = new sst.aws.Vpc('Vpc');
    const cluster = new sst.aws.Cluster('Cluster', { vpc });

    const api = new sst.aws.Service('Api', {
      cluster,
      cpu: '0.25 vCPU',
      memory: '0.5 GB',
      scaling: { min: 1, max: 1 },
      image: {
        context: '.',
        dockerfile: 'apps/api/Dockerfile',
      },
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        CORS_ORIGINS: `https://${webDomain}`,
      },
      loadBalancer: {
        domain: {
          name: apiDomain,
          dns: sst.aws.dns(),
        },
        rules: [
          { listen: '80/http', redirect: '443/https' },
          { listen: '443/https', forward: '3000/http' },
        ],
        health: {
          '3000/http': {
            path: '/health',
            interval: '30 seconds',
            successCodes: '200',
          },
        },
      },
    });

    const web = new sst.aws.StaticSite('Web', {
      path: 'apps/web',
      build: {
        command: 'pnpm build',
        output: 'dist',
      },
      environment: {
        VITE_API_URL: $interpolate`https://${apiDomain}`,
      },
      domain: {
        name: webDomain,
        dns: sst.aws.dns(),
      },
    });

    return {
      web: web.url,
      api: api.url,
      apiDomain: $interpolate`https://${apiDomain}`,
      webDomain: $interpolate`https://${webDomain}`,
    };
  },
});
