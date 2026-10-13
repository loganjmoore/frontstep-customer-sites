// Idempotent service discovery and revision-confirmed publication. Clients are injectable for tests.
export async function reconcilePublication({render, acknowledge, ownerId, repo, slug, revision, serviceId, wait = ms => new Promise(r => setTimeout(r, ms)), attempts = 40}) {
  if (!ownerId || !repo || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid publication identity');
  const name = `fss-${slug}`.slice(0, 60);
  const matches = s => s.type === 'static_site' && s.name === name && s.ownerId === ownerId && s.repo === repo && s.branch === 'main' && s.rootDir === `sites/${slug}`;
  let service;
  if (serviceId) {
    service = await render(`/services/${serviceId}`);
    if (!matches(service)) throw new Error('Stored service does not match this customer site');
  } else {
    let cursor = '';
    const found = [];
    for (let page = 0; page < 100; page++) {
      const rows = await render(`/services?ownerId=${encodeURIComponent(ownerId)}&name=${encodeURIComponent(name)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const row of rows) if (matches(row.service ?? row)) found.push(row.service ?? row);
      if (rows.length < 100) break;
      const next = rows.at(-1)?.cursor;
      if (!next || next === cursor || page === 99) throw new Error('Service discovery incomplete; refusing duplicate creation');
      cursor = next;
    }
    if (found.length > 1) throw new Error('Ambiguous customer service; team review required');
    service = found[0];
    if (!service) {
      const created = await render('/services', {method:'POST', body:JSON.stringify({type:'static_site',name,ownerId,repo,branch:'main',rootDir:`sites/${slug}`,autoDeploy:'yes',serviceDetails:{publishPath:'.',pullRequestPreviewsEnabled:'no'}})});
      service = created.service ?? created;
    }
  }
  if (!service.id || !service.serviceDetails?.url) throw new Error('Incomplete publication service');
  const host = new URL(service.serviceDetails.url).host;
  // Save identity before other side effects. A crash here is recovered by exact service discovery.
  await acknowledge({renderServiceId:service.id,host});
  const deployed = async () => (await render(`/services/${service.id}/deploys?limit=100`)).map(x => x.deploy ?? x);
  let rows = await deployed();
  const current = () => rows.find(d => d.status === 'live');
  const activeStatuses = ['created','build_in_progress','update_in_progress','pre_deploy_in_progress'];
  let attempt = rows.find(d => d.commit?.id === revision && activeStatuses.includes(d.status));
  if (current()?.commit?.id !== revision && !attempt) {
    const created = await render(`/services/${service.id}/deploys`, {method:'POST',body:JSON.stringify({commitId:revision})});
    attempt = created.deploy ?? created;
    if (!attempt?.id) throw new Error('Publication attempt identity unavailable; request remains incomplete');
  }
  for (let n=0;n<attempts;n++) {
    rows = await deployed();
    if (current()?.commit?.id === revision) return {id:service.id,host};
    if (attempt?.id && rows.some(d => d.id === attempt.id && ['build_failed','update_failed','pre_deploy_failed','canceled'].includes(d.status))) throw new Error('Publication failed; request remains incomplete');
    await wait(10_000);
  }
  throw new Error('Publication not confirmed before deadline; request remains incomplete');
}
