/**
 * Local DNS escape hatch. Opt-in, dev only — see FAILURES.md #1.
 *
 * Some consumer routers (this build was written on an Airtel one) return
 * REFUSED for Neon's per-endpoint subdomains, so `getaddrinfo` fails and every
 * database call dies with ENOTFOUND while the rest of the internet works fine.
 * Node's dns.setServers does not help, because dns.lookup goes through the
 * system resolver rather than Node's own. So dns.lookup is patched to resolve
 * through an explicit public resolver, falling back to the system one.
 *
 * The real fix is to set the machine's DNS to 1.1.1.1. This exists so a bad
 * cafe/hotel network cannot cost an hour on deadline day.
 *
 *   npm run dev:dnsfix        instead of  npm run dev
 *   npm run db:migrate:dnsfix instead of  npm run db:migrate
 */
const dns = require('node:dns');

const servers = (process.env.DNS_FALLBACK_SERVERS || '1.1.1.1,8.8.8.8').split(',');
const resolver = new dns.Resolver();
resolver.setServers(servers);

const systemLookup = dns.lookup;

dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  resolver.resolve4(hostname, (err, addresses) => {
    if (err || !addresses || addresses.length === 0) {
      return systemLookup.call(dns, hostname, options, callback);
    }
    if (options && options.all) {
      return callback(null, addresses.map((address) => ({ address, family: 4 })));
    }
    callback(null, addresses[0], 4);
  });
};

console.warn(`[dns-fallback] dns.lookup routed through ${servers.join(', ')}`);
