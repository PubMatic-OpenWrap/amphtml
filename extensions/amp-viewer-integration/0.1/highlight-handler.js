/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Services} from '../../../src/services';
import {dict} from '../../../src/utils/object';
import {findSentences, markTextRangeList} from './findtext';
import {listenOnce} from '../../../src/event-helper';
import {parseJson} from '../../../src/json';
import {parseQueryString} from '../../../src/url';
import {resetStyles, setStyles} from '../../../src/style';

/**
 * The message name sent by viewers to dismiss highlights.
 * @type {string}
 */
const HIGHLIGHT_DISMISS = 'highlightDismiss';

/**
 * The message name sent by AMP doc to notify the change of the state of text
 * highlighting.
 * @type {string}
 */
const HIGHLIGHT_STATE = 'highlightState';

/**
 * The length limit of highlight param to avoid parsing
 * a incredibley large string as JSON. The limit is 100kB.
 * @type {number}
 */
const HIGHLIGHT_PARAM_LENGTH_LIMIT = 100 << 10;

/**
 * The limit of # of sentences to highlight.
 * @type {number}
 */
const NUM_SENTENCES_LIMIT = 15;

/**
 * The length limit of one sentence to highlight.
 * @type {number}
 */
const NUM_ALL_CHARS_LIMIT = 1500;

/**
 * TextRange represents a text range.
 * @typedef {{sentences: !Array<string>}}
 */
let HighlightInfoDef;

/**
 * The upper bound of the height of scrolling-down animation to highlighted
 * texts. If the height for animation exceeds this limit, we scroll the viewport
 * to the certain position before animation to control the speed of animation.
 * @type {number}
 */
const SCROLL_ANIMATION_HEIGHT_LIMIT = 1000;

/**
 * Returns highlight param in the URL hash.
 * @param {!../../../src/service/ampdoc-impl.AmpDoc} ampdoc
 * @return {?HighlightInfoDef}
 */
export function getHighlightParam(ampdoc) {
  const param = parseQueryString(ampdoc.win.location.hash)['highlight'];
  if (!param || param.length > HIGHLIGHT_PARAM_LENGTH_LIMIT) {
    return null;
  }
  const highlight = parseJson(param);
  const sens = highlight['s'];
  if (!(sens instanceof Array) || sens.length > NUM_SENTENCES_LIMIT) {
    // Too many sentences, do nothing for safety.
    return null;
  }
  let sum = 0;
  for (let i = 0; i < sens.length; i++) {
    const sen = sens[i];
    if (typeof sen != 'string' || !sen) {
      // Invalid element in sens.
      return null;
    }
    sum += sen.length;
    if (sum > NUM_ALL_CHARS_LIMIT) {
      // Too many chars, do nothing for safety.
      return null;
    }
  }
  return {
    sentences: sens,
  };
}

/**
 * HighlightHandler reads highlight parameter from URL and
 * highlights specified text in AMP documents.
 */
export class HighlightHandler {
  /**
   * @param {!../../../src/service/ampdoc-impl.AmpDoc} ampdoc
   * @param {!HighlightInfoDef} highlightInfo The highlighting info in JSON.
   */
  constructor(ampdoc, highlightInfo) {
    /** @private @const {!../../../src/service/ampdoc-impl.AmpDoc} */
    this.ampdoc_ = ampdoc;
    /** @private @const {!../../../src/service/viewer-impl.Viewer} */
    this.viewer_ = Services.viewerForDoc(ampdoc);

    /** @private {?Array<!Element>} */
    this.highlightedNodes_ = null;

    this.initHighlight_(highlightInfo);
  }

  /**
   * @param {string} state
   * @param {JsonObject=} opt_params
   * @private
   */
  sendHighlightState_(state, opt_params) {
    const params = dict({'state': state});
    for (const key in opt_params) {
      params[key] = opt_params[key];
    }
    this.viewer_.sendMessage(HIGHLIGHT_STATE, params);
  }

  /**
   * @param {!HighlightInfoDef} highlightInfo
   * @private
   */
  findHighlightedNodes_(highlightInfo) {
    const {win} = this.ampdoc_;
    const sens = findSentences(
        win, this.ampdoc_.getBody(), highlightInfo.sentences);
    if (!sens) {
      return;
    }
    const nodes = markTextRangeList(win, sens);
    if (!nodes || nodes.length == 0) {
      return;
    }
    this.highlightedNodes_ = nodes;
  }

  /**
   * @param {!HighlightInfoDef} highlightInfo
   * @private
   */
  initHighlight_(highlightInfo) {
    this.findHighlightedNodes_(highlightInfo);
    if (!this.highlightedNodes_) {
      this.sendHighlightState_('not_found');
      return;
    }
    const scrollTop = this.calcTopToCenterHighlightedNodes_();
    this.sendHighlightState_('found', dict({'scroll': scrollTop}));

    for (let i = 0; i < this.highlightedNodes_.length; i++) {
      const n = this.highlightedNodes_[i];
      n['style']['backgroundColor'] = '#ff0';
      n['style']['color'] = '#333';
    }

    const visibility = this.viewer_.getVisibilityState();
    if (visibility == 'visible') {
      this.animateScrollToTop_(scrollTop);
    } else {
      if (scrollTop > SCROLL_ANIMATION_HEIGHT_LIMIT) {
        Services.viewportForDoc(this.ampdoc_).setScrollTop(
            scrollTop - SCROLL_ANIMATION_HEIGHT_LIMIT);
      }
      let called = false;
      this.viewer_.onVisibilityChanged(() => {
        // TODO(yunabe): Unregister the handler.
        if (called || this.viewer_.getVisibilityState() != 'visible') {
          return;
        }
        this.animateScrollToTop_(this.calcTopToCenterHighlightedNodes_());
        called = true;
      });
    }
    listenOnce(this.ampdoc_.getBody(), 'click',
        this.dismissHighlight_.bind(this));
  }

  /**
   * @return {number}
   * @private
   */
  calcTopToCenterHighlightedNodes_() {
    const nodes = this.highlightedNodes_;
    if (!nodes) {
      return 0;
    }
    const viewport = Services.viewportForDoc(this.ampdoc_);
    let minTop = Number.MAX_VALUE;
    let maxBottom = 0;
    for (let i = 0; i < nodes.length; i++) {
      const {top, bottom} = viewport.getLayoutRect(nodes[i]);
      minTop = Math.min(minTop, top);
      maxBottom = Math.max(maxBottom, bottom);
    }
    if (minTop >= maxBottom) {
      return 0;
    }
    const height = viewport.getHeight() - viewport.getPaddingTop();
    if (maxBottom - minTop > height) {
      return minTop;
    }
    const pos = (maxBottom + minTop - height) / 2;
    return pos > 0 ? pos : 0;
  }

  /**
   * @param {number} top
   * @private
   */
  animateScrollToTop_(top) {
    const sentinel = this.ampdoc_.win.document.createElement('div');
    setStyles(sentinel, {
      'position': 'absolute',
      'top': Math.floor(top) + 'px',
      'bottom': '0',
      'left': '0',
      'right': '0',
      'pointer-events': 'none',
    });
    const body = this.ampdoc_.getBody();
    body.appendChild(sentinel);
    this.sendHighlightState_('auto_scroll');
    Services.viewportForDoc(this.ampdoc_)
        .animateScrollIntoView(sentinel).then(() => {
          this.sendHighlightState_('shown');
          body.removeChild(sentinel);
        });
  }

  /**
   * @param {!./messaging/messaging.Messaging} messaging
   */
  setupMessaging(messaging) {
    messaging.registerHandler(
        HIGHLIGHT_DISMISS, this.dismissHighlight_.bind(this));
  }

  /**
   * @private
   */
  dismissHighlight_() {
    if (!this.highlightedNodes_) {
      return;
    }
    for (let i = 0; i < this.highlightedNodes_.length; i++) {
      resetStyles(this.highlightedNodes_[i], ['backgroundColor', 'color']);
    }
  }
}
