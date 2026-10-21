// pagesnap UI entry point. Talks to lib/server.js over /api/*. No dependencies.
//
//   dom.js      $, el(), icon(), btn()           format.js   text for sizes, times, URLs
//   api.js      fetch wrapper, file/ZIP URLs     store.js    localStorage memory
//   events.js   on()/emit() between modules      toast.js    status messages
//   theme.js    light/dark                       tabs.js     Capture / History tabs
//   options.js  the sidebar form → request       url.js      the URL field and its checks
//   view.js     job panel header and notices     capture.js  a running capture (SSE progress)
//   result.js   a finished capture and preview   history.js  History tab and recent list
//   batch.js    a list of pages: editor and grid

import { showEmpty } from './view.js';
import { api } from './api.js';
import { initTheme } from './theme.js';
import { initTabs } from './tabs.js';
import { initOptions, setDevices } from './options.js';
import { initUrl } from './url.js';
import { initResult } from './result.js';
import { initCapture, setSteps } from './capture.js';
import { initHistory } from './history.js';
import { initBatch, setParallel } from './batch.js';

initTheme();
initTabs();
initOptions();
initUrl();
initResult();
initCapture();
initHistory();
initBatch();
showEmpty();

api('/api/config').then(({ devices, steps, parallel }) => {
  setSteps(steps);
  setParallel(parallel);
  setDevices(devices);
}).catch(() => {});
