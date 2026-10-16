/**
 * Reports the environment values a transport-child probe is allowed to observe.
 *
 * The TLS variables are printed as a presence marker, never as a path, so a probe run leaves no
 * machine-specific detail behind.
 */
console.log(JSON.stringify({
  sentinel: process.env.DSH_P22_ENV_SENTINEL ?? null,
  sentinelBase: process.env.DSH_P22_ENV_SENTINEL_BASE ?? null,
  tlsReject: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
  extraCa: process.env.NODE_EXTRA_CA_CERTS === undefined ? null : 'set',
  sslCertFile: process.env.SSL_CERT_FILE === undefined ? null : 'set',
  sslCertDir: process.env.SSL_CERT_DIR === undefined ? null : 'set',
}))
