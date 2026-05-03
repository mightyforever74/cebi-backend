module.exports = {
  apps: [{
    name: 'fleet-staging',
    script: 'server.js',
    cwd: '/opt/fleet/backend-staging',
    env_file: '.env',
  }]
};
