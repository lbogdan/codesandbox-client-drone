import * as React from 'react';
import {
  Sandbox,
  Module,
  SSEManagerStatus,
  SSEContainerStatus,
} from '../../types';
import {
  listen,
  dispatch,
  actions,
  registerFrame,
  resetState,
} from 'codesandbox-api';
import debounce from 'lodash/debounce';
import io from 'socket.io-client';

import { frameUrl, host } from '../../utils/url-generator';
import { getModulePath } from '../../sandbox/modules';
import getTemplate from '../../templates';

import { Spring } from 'react-spring/renderprops.cjs';

import { generateFileFromSandbox } from '../../templates/configuration/package-json';

import { notificationState } from '../../utils/notifications';
import { getSandboxName } from '../../utils/get-sandbox-name';

import Navigator from './Navigator';
import { Container, StyledFrame, Loading } from './elements';
import { Settings } from './types';
import { NotificationStatus } from '@codesandbox/notifications';

export type Props = {
  sandbox: Sandbox;
  settings: Settings;
  onInitialized?: (preview: BasePreview) => () => void; // eslint-disable-line no-use-before-define
  extraModules?: { [path: string]: { code: string; path: string } };
  currentModule?: Module;
  initialPath?: string;
  isInProjectView?: boolean;
  onClearErrors?: () => void;
  onAction?: (action: Object) => void;
  onOpenNewWindow?: () => void;
  onToggleProjectView?: () => void;
  isResizing?: boolean;
  onResize?: (height: number) => void;
  showNavigation?: boolean;
  inactive?: boolean;
  dragging?: boolean;
  hide?: boolean;
  noPreview?: boolean;
  alignDirection?: 'right' | 'bottom';
  delay?: number;
  setSSEManagerStatus?: (status: SSEManagerStatus) => void;
  setSSEContainerStatus?: (status: SSEContainerStatus) => void;
  managerStatus?: SSEManagerStatus;
  containerStatus?: SSEContainerStatus;
  syncSandbox?: (updates: any) => void;
  className?: string;
};

type State = {
  frameInitialized: boolean;
  history: string[];
  historyPosition: number;
  urlInAddressBar: string;
  url: string | undefined;
  overlayMessage: string | undefined;
  hibernated: boolean;
  sseError: boolean;
  showScreenshot: boolean;
};

const getSSEUrl = (sandbox?: Sandbox, initialPath: string = '') =>
  `https://${sandbox ? `${sandbox.id}.` : ''}sse.${
    (process.env.NODE_ENV === 'development' || process.env.STAGING) ? 'codesandbox.io' : host()
  }${initialPath}`;

interface IModulesByPath {
  [path: string]: { path: string; code: null | string; isBinary?: boolean };
}

const getDiff = (a: IModulesByPath, b: IModulesByPath) => {
  const diff: IModulesByPath = {};

  Object.keys(b)
    .filter(p => {
      if (a[p]) {
        if (a[p].code !== b[p].code) {
          return true;
        }
      } else {
        return true;
      }

      return false;
    })
    .forEach(p => {
      diff[p] = {
        code: b[p].code,
        path: p,
        isBinary: b[p].isBinary,
      };
    });

  Object.keys(a).forEach(p => {
    if (!b[p]) {
      diff[p] = {
        path: p,
        code: null,
      };
    }
  });

  return diff;
};

const MAX_SSE_AGE = 24 * 60 * 60 * 1000; // 1 day
async function retrieveSSEToken() {
  const jwt = localStorage.getItem('jwt');

  if (jwt) {
    const parsedJWT = JSON.parse(jwt);
    const existingKey = localStorage.getItem('sse');
    const currentTime = new Date().getTime();

    if (existingKey) {
      const parsedKey = JSON.parse(existingKey);
      if (parsedKey.key && currentTime - parsedKey.timestamp < MAX_SSE_AGE) {
        return parsedKey.key;
      }
    }

    return fetch('/api/v1/users/current_user/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${parsedJWT}`,
      },
    })
      .then(x => x.json())
      .then(result => result.jwt)
      .then(token => {
        localStorage.setItem(
          'sse',
          JSON.stringify({
            key: token,
            timestamp: currentTime,
          })
        );

        return token;
      })
      .catch(() => null);
  }

  return null;
}

function sseTerminalMessage(msg) {
  dispatch({
    type: 'terminal:message',
    data: `> Sandbox Container: ${msg}\n\r`,
  });
}

class BasePreview extends React.Component<Props, State> {
  serverPreview: boolean;
  lastSent: {
    sandboxId: string;
    modules: IModulesByPath;
  };

  $socket: SocketIOClient.Socket;
  connectTimeout: number | undefined;
  // indicates if the socket closing is initiated by us
  localClose: boolean;

  constructor(props: Props) {
    super(props);
    // We have new behaviour in the preview for server templates, which are
    // templates that are executed in a docker container.
    this.serverPreview = getTemplate(props.sandbox.template).isServer;

    this.state = {
      frameInitialized: false,
      history: [],
      historyPosition: 0,
      urlInAddressBar: this.serverPreview
        ? getSSEUrl(props.sandbox, props.initialPath)
        : frameUrl(props.sandbox, props.initialPath || ''),
      url: null,
      overlayMessage: null,
      hibernated: false,
      sseError: false,
      showScreenshot: true,
    };

    // we need a value that doesn't change when receiving `initialPath`
    // from the query params, or the iframe will continue to be re-rendered
    // when the user navigates the iframe app, which shows the loading screen
    this.initialPath = props.initialPath;

    this.initializeLastSent();

    if (this.serverPreview) {
      this.connectTimeout = null;
      this.localClose = false;
      this.setupSSESockets();

      setTimeout(() => {
        // Remove screenshot after specific time, so the loading container spinner can still show
        this.setState({ showScreenshot: false });
      }, 100);
    }
    this.listener = listen(this.handleMessage);

    if (props.delay) {
      this.executeCode = debounce(this.executeCode, 800);
    }

    (window as any).openNewWindow = this.openNewWindow;
  }

  initializeLastSent = () => {
    this.lastSent = {
      sandboxId: this.props.sandbox.id,
      modules: this.getModulesToSend(),
    };
  };

  componentWillUpdate(nextProps: Props, nextState: State) {
    if (
      nextState.frameInitialized !== this.state.frameInitialized &&
      nextState.frameInitialized
    ) {
      this.handleRefresh();
    }
  }

  setupSSESockets = async () => {
    const hasInitialized = Boolean(this.$socket);

    function onTimeout(comp: BasePreview) {
      comp.connectTimeout = null;
      if (comp.props.setSSEManagerStatus) {
        comp.props.setSSEManagerStatus('disconnected');
      }
    }

    if (hasInitialized) {
      this.setState({
        frameInitialized: false,
      });
      if (this.$socket) {
        this.localClose = true;
        this.$socket.close();
        // we need this setTimeout() for socket open() to work immediately after close()
        setTimeout(() => {
          this.connectTimeout = window.setTimeout(() => onTimeout(this), 3000);
          this.$socket.open();
        }, 0);
      }
    } else {
      const socket = io(getSSEUrl(), {
        autoConnect: false,
        transports: ['websocket', 'polling'],
      });
      this.$socket = socket;
      if (process.env.NODE_ENV === 'development') {
        (window as any).$socket = socket;
      }

      socket.on('disconnect', () => {
        if (this.localClose) {
          this.localClose = false;
          return;
        }

        if (
          this.props.setSSEManagerStatus &&
          this.props.managerStatus === 'connected' &&
          this.props.containerStatus !== 'hibernated'
        ) {
          this.props.setSSEManagerStatus('disconnected');
          dispatch({ type: 'codesandbox:sse:disconnect' });
        }
      });

      socket.on('connect', async () => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }

        if (this.props.setSSEManagerStatus) {
          this.props.setSSEManagerStatus('connected');
        }

        const { id } = this.props.sandbox;
        const token = await retrieveSSEToken();

        socket.emit('sandbox', { id, token });

        sseTerminalMessage(`connected, starting sandbox ${id}...`);

        socket.emit('sandbox:start');
      });

      socket.on('shell:out', ({ data, id }) => {
        dispatch({
          type: 'shell:out',
          data,
          id,
        });
      });

      socket.on('shell:exit', ({ id, code, signal }) => {
        dispatch({
          type: 'shell:exit',
          code,
          signal,
          id,
        });
      });

      socket.on('sandbox:update', message => {
        if (this.props.syncSandbox) {
          this.props.syncSandbox({ updates: message.updates });
        }
      });

      socket.on('sandbox:status', message => {
        if (this.props.setSSEContainerStatus) {
          if (message.status === 'starting-container') {
            this.props.setSSEContainerStatus('initializing');
          } else if (message.status === 'installing-packages') {
            this.props.setSSEContainerStatus('container-started');
          }
        }
      });

      socket.on('sandbox:start', () => {
        sseTerminalMessage(`sandbox ${this.props.sandbox.id} started.`);

        if (!this.state.frameInitialized && this.props.onInitialized) {
          this.disposeInitializer = this.props.onInitialized(this);
        }

        this.setState({
          frameInitialized: true,
          overlayMessage: null,
        });
        if (this.props.setSSEContainerStatus) {
          this.props.setSSEContainerStatus('sandbox-started');
        }

        setTimeout(() => {
          this.executeCodeImmediately(true);
          this.handleRefresh();
        });
      });

      socket.on('sandbox:hibernate', () => {
        sseTerminalMessage(`sandbox ${this.props.sandbox.id} hibernated.`);

        if (this.props.setSSEContainerStatus) {
          this.props.setSSEContainerStatus('hibernated');
        }

        this.setState(
          {
            frameInitialized: false,
            overlayMessage:
              'The sandbox was hibernated because of inactivity. Refresh the page to restart it.',
          },
          () => this.$socket.close()
        );
      });

      socket.on('sandbox:stop', () => {
        sseTerminalMessage(`sandbox ${this.props.sandbox.id} restarting...`);

        if (this.props.setSSEContainerStatus) {
          this.props.setSSEContainerStatus('stopped');
        }

        this.setState({
          frameInitialized: false,
          overlayMessage: 'Restarting the sandbox...',
        });
      });

      socket.on('sandbox:log', ({ data }) => {
        dispatch({
          type: 'terminal:message',
          data,
        });
      });

      socket.on('sandbox:error', ({ message, unrecoverable }) => {
        sseTerminalMessage(
          `sandbox ${this.props.sandbox.id} ${
            unrecoverable ? 'unrecoverable ' : ''
          }error "${message}"`
        );
        if (unrecoverable) {
          this.setState(
            {
              frameInitialized: false,
              overlayMessage:
                'An unrecoverable sandbox error occurred. :-( Try refreshing the page.',
              sseError: true,
            },
            () => this.$socket.close()
          );
        } else {
          notificationState.addNotification({
            message: `Sandbox Container: ${message}`,
            status: NotificationStatus.ERROR,
          });
        }
      });

      this.connectTimeout = window.setTimeout(() => onTimeout(this), 3000);
      socket.open();
    }
  };

  static defaultProps = {
    showNavigation: true,
    delay: true,
  };

  listener: () => void;
  disposeInitializer: () => void;
  initialPath: string;

  componentWillUnmount() {
    if (this.listener) {
      this.listener();
    }
    if (this.disposeInitializer) {
      this.disposeInitializer();
    }

    if (this.$socket) {
      this.localClose = true;
      this.$socket.close();
    }
  }

  componentDidUpdate(prevProps: Props) {
    if (
      prevProps.sandbox &&
      this.props.sandbox &&
      prevProps.sandbox.id !== this.props.sandbox.id
    ) {
      this.handleSandboxChange(this.props.sandbox);
    }
  }

  openNewWindow = () => {
    if (this.props.onOpenNewWindow) {
      this.props.onOpenNewWindow();
    }

    window.open(this.state.urlInAddressBar, '_blank');
  };

  handleSandboxChange = (sandbox: Sandbox) => {
    this.serverPreview = getTemplate(this.props.sandbox.template).isServer;

    resetState();

    const url = this.serverPreview
      ? getSSEUrl(sandbox, this.props.initialPath)
      : frameUrl(sandbox, this.props.initialPath || '');

    if (this.serverPreview) {
      this.initializeLastSent();
      this.setupSSESockets();

      setTimeout(() => {
        // Remove screenshot after specific time, so the loading container spinner can still show
        this.setState({ showScreenshot: false });
      }, 800);
    }

    this.setState(
      {
        history: [url],
        historyPosition: 0,
        urlInAddressBar: url,
        showScreenshot: true,
        overlayMessage: null,
      },
      () => this.handleRefresh()
    );
  };

  handleDependenciesChange = () => {
    this.handleRefresh();
  };

  handleMessage = (data: any, source: any) => {
    if (data && data.codesandbox) {
      if (data.type === 'initialized' && source) {
        registerFrame(
          source,
          this.serverPreview
            ? getSSEUrl(this.props.sandbox)
            : frameUrl(this.props.sandbox)
        );

        if (!this.state.frameInitialized && this.props.onInitialized) {
          this.disposeInitializer = this.props.onInitialized(this);
        }

        setTimeout(
          () => {
            // We show a screenshot of the sandbox (if available) on top of the preview if the frame
            // hasn't loaded yet
            this.setState({ showScreenshot: false });
          },
          this.serverPreview ? 0 : 600
        );

        this.executeCodeImmediately(true);
      } else {
        const { type } = data;

        switch (type) {
          case 'render': {
            this.executeCodeImmediately();
            break;
          }
          case 'urlchange': {
            this.commitUrl(data.url, data.action, data.diff);
            break;
          }
          case 'resize': {
            if (this.props.onResize) {
              this.props.onResize(data.height);
            }
            break;
          }
          case 'action': {
            if (this.props.onAction) {
              this.props.onAction({
                ...data,
                sandboxId: this.props.sandbox.id,
              });
            }

            break;
          }
          case 'socket:message': {
            if (this.$socket) {
              const { channel, type: _t, codesandbox: _c, ...message } = data;
              this.$socket.emit(channel, message);
            }

            break;
          }
          case 'done': {
            this.setState({ showScreenshot: false });
            break;
          }
          default: {
            break;
          }
        }
      }
    }
  };

  executeCode = () => {
    requestAnimationFrame(() => {
      this.executeCodeImmediately();
    });
  };

  getRenderedModule = () => {
    const { sandbox, currentModule, isInProjectView } = this.props;

    return isInProjectView
      ? '/' + sandbox.entry
      : getModulePath(sandbox.modules, sandbox.directories, currentModule.id);
  };

  getModulesToSend = (): IModulesByPath => {
    const modulesObject: IModulesByPath = {};
    const sandbox = this.props.sandbox;

    sandbox.modules.forEach(m => {
      const path = getModulePath(sandbox.modules, sandbox.directories, m.id);
      if (path) {
        modulesObject[path] = {
          path,
          code: m.code,
          isBinary: m.isBinary,
        };
      }
    });

    const extraModules = this.props.extraModules || {};
    const modulesToSend = { ...extraModules, ...modulesObject };

    if (!modulesToSend['/package.json']) {
      modulesToSend['/package.json'] = {
        code: generateFileFromSandbox(sandbox),
        path: '/package.json',
        isBinary: false,
      };
    }

    return modulesToSend;
  };

  executeCodeImmediately = (initialRender: boolean = false) => {
    const settings = this.props.settings;
    const sandbox = this.props.sandbox;

    if (settings.clearConsoleEnabled && !this.serverPreview) {
      // @ts-ignore Chrome behaviour
      console.clear('__internal__'); // eslint-disable-line no-console
      dispatch({ type: 'clear-console' });
    }

    // Do it here so we can see the dependency fetching screen if needed
    this.clearErrors();
    if (settings.forceRefresh && !initialRender) {
      this.handleRefresh();
    } else {
      if (!this.props.isInProjectView) {
        dispatch({
          type: 'evaluate',
          command: `history.pushState({}, null, '/')`,
        });
      }

      const modulesToSend = this.getModulesToSend();
      if (this.serverPreview) {
        const diff = getDiff(this.lastSent.modules, modulesToSend);
        if (this.props.containerStatus === 'sandbox-started') {
          // Only mark the last modules if we're sure that the container has been able
          // to process the last diff
          this.lastSent.modules = modulesToSend;
        }

        if (Object.keys(diff).length > 0 && this.$socket) {
          this.$socket.emit('sandbox:update', diff);
        }
      } else {
        dispatch({
          type: 'compile',
          version: 3,
          entry: this.getRenderedModule(),
          modules: modulesToSend,
          sandboxId: sandbox.id,
          externalResources: sandbox.externalResources,
          isModuleView: !this.props.isInProjectView,
          template: sandbox.template,
          hasActions: Boolean(this.props.onAction),
        });
      }
    }
  };

  clearErrors = () => {
    dispatch(actions.error.clear('*', 'browser'));
    if (this.props.onClearErrors) {
      this.props.onClearErrors();
    }
  };

  updateUrl = (url: string) => {
    this.setState({ urlInAddressBar: url });
  };

  sendUrl = () => {
    const { urlInAddressBar } = this.state;

    const el = document.getElementById('sandbox');
    if (el) {
      (el as HTMLIFrameElement).src = urlInAddressBar;

      this.setState({
        history: [urlInAddressBar],
        historyPosition: 0,
        urlInAddressBar,
      });
    }
  };

  handleRefresh = () => {
    const { history, historyPosition, urlInAddressBar } = this.state;
    const url = history[historyPosition] || urlInAddressBar;

    const el = document.getElementById('sandbox');
    if (el) {
      (el as HTMLIFrameElement).src =
        url ||
        (this.serverPreview
          ? getSSEUrl(this.props.sandbox)
          : frameUrl(this.props.sandbox));
    }

    this.setState({
      history: [url],
      historyPosition: 0,
      urlInAddressBar: url,
    });
  };

  handleBack = () => {
    dispatch({
      type: 'urlback',
    });
  };

  handleForward = () => {
    dispatch({
      type: 'urlforward',
    });
  };

  commitUrl = (url: string, action: string, diff: number) => {
    const { history, historyPosition } = this.state;

    switch (action) {
      case 'POP':
        this.setState(prevState => {
          const newPosition = prevState.historyPosition + diff;
          return {
            historyPosition: newPosition,
            urlInAddressBar: url,
          };
        });
        break;
      case 'REPLACE':
        this.setState(prevState => ({
          history: [
            ...prevState.history.slice(0, historyPosition),
            url,
            ...prevState.history.slice(historyPosition + 1),
          ],
          urlInAddressBar: url,
        }));
        break;
      default:
        this.setState({
          history: [...history.slice(0, historyPosition + 1), url],
          historyPosition: historyPosition + 1,
          urlInAddressBar: url,
        });
    }
  };

  toggleProjectView = () => {
    if (this.props.onToggleProjectView) {
      this.props.onToggleProjectView();
    }
  };

  render() {
    const {
      showNavigation,
      inactive,
      sandbox,
      settings,
      isInProjectView,
      dragging,
      hide,
      noPreview,
      className,
    } = this.props;

    const {
      historyPosition,
      history,
      urlInAddressBar,
      overlayMessage,
    } = this.state;

    const url =
      urlInAddressBar ||
      (this.serverPreview ? getSSEUrl(sandbox) : frameUrl(sandbox));

    if (noPreview) {
      // Means that preview is open in another tab definitely
      return null;
    }

    // Weird TS typing bug
    const AnySpring = Spring as any;

    return (
      <Container
        className={className}
        style={{
          position: 'relative',
          flex: 1,
          display: hide ? 'none' : undefined,
        }}
      >
        {showNavigation && (
          <Navigator
            url={decodeURIComponent(url)}
            onChange={this.updateUrl}
            onConfirm={this.sendUrl}
            onBack={historyPosition > 0 ? this.handleBack : null}
            onForward={
              historyPosition < history.length - 1 ? this.handleForward : null
            }
            onRefresh={this.handleRefresh}
            isProjectView={isInProjectView}
            toggleProjectView={
              this.props.onToggleProjectView && this.toggleProjectView
            }
            openNewWindow={this.openNewWindow}
            zenMode={settings.zenMode}
            isServer={this.serverPreview}
          />
        )}
        {overlayMessage && <Loading>{overlayMessage}</Loading>}

        <AnySpring
          from={{ opacity: 0 }}
          to={{
            opacity: this.state.showScreenshot ? 0 : 1,
          }}
        >
          {(style: { opacity: number }) => (
            <React.Fragment>
              <StyledFrame
                sandbox="allow-forms allow-scripts allow-same-origin allow-modals allow-popups allow-presentation"
                src={
                  this.serverPreview
                    ? getSSEUrl(sandbox, this.initialPath)
                    : frameUrl(sandbox, this.initialPath)
                }
                id="sandbox"
                title={getSandboxName(sandbox)}
                style={{
                  ...style,
                  zIndex: 1,
                  backgroundColor: 'white',
                  pointerEvents:
                    dragging || inactive || this.props.isResizing
                      ? 'none'
                      : 'initial',
                }}
              />

              {this.props.sandbox.screenshotUrl && style.opacity !== 1 && (
                <div
                  style={{
                    overflow: 'hidden',
                    width: '100%',
                    position: 'absolute',
                    display: 'flex',
                    justifyContent: 'center',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    top: 35,
                    zIndex: 0,
                  }}
                >
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      filter: `blur(2px)`,
                      transform: 'scale(1.025, 1.025)',
                      backgroundImage: `url("${
                        this.props.sandbox.screenshotUrl
                      }")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPositionX: 'center',
                    }}
                  />
                </div>
              )}
            </React.Fragment>
          )}
        </AnySpring>
      </Container>
    );
  }
}

export default BasePreview;
