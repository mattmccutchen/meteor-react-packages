/* global Package */
/* eslint-disable react/prefer-stateless-function */

import React from 'react';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

// A class to keep the state and utility methods needed to manage
// the Meteor data for a component.
class MeteorDataManager {
  constructor(component) {
    this.component = component;
    this.computation = null;
    this.oldData = null;
  }

  dispose() {
    if (this.computation) {
      this.computation.stop();
      this.computation = null;
    }
  }

  calculateData() {
    const component = this.component;

    if (!component.getMeteorData) {
      return null;
    }

    // When rendering on the server, we don't want to use the Tracker.
    // We only do the first rendering on the server so we can get the data right away
    if (Meteor.isServer) {
      return component.getMeteorData();
    }

    if (this.computation) {
      this.computation.stop();
      this.computation = null;
    }

    let data;
    // Use Tracker.nonreactive in case we are inside a Tracker Computation.
    // This can happen if someone calls `ReactDOM.render` inside a Computation.
    // In that case, we want to opt out of the normal behavior of nested
    // Computations, where if the outer one is invalidated or stopped,
    // it stops the inner one.
    this.computation = Tracker.nonreactive(() => (
      Tracker.autorun((c) => {
        if (c.firstRun) {
          const savedSetState = component.setState;
          try {
            component.setState = () => {
              throw new Error(
                'Can\'t call `setState` inside `getMeteorData` as this could '
                + 'cause an endless loop. To respond to Meteor data changing, '
                + 'consider making this component a \"wrapper component\" that '
                + 'only fetches data and passes it in as props to a child '
                + 'component. Then you can use `componentWillReceiveProps` in '
                + 'that child component.');
            };

            data = component.getMeteorData();
            if (!(data && (typeof data) === 'object')) {
              throw new Error('Expected object returned from getMeteorData');
            }
          } catch (e) {
            // If we throw the exception out of the autorun, it won't be rerun
            // when the dependencies change.  Even if we pass it out, if we
            // throw it out of calculateData, React treats that as an error in
            // the wrapper component, which our error boundary doesn't catch.
            //
            // TODO: Use a better error logging utility when available
            // (https://github.com/meteor/meteor-feature-requests/issues/205).
            console.error("Exception from withTracker getMeteorData function:", e);
            data = undefined;
          } finally {
            component.setState = savedSetState;
          }
        } else {
          // Stop this computation instead of using the re-run.
          // We use a brand-new autorun for each call to getMeteorData
          // to capture dependencies on any reactive data sources that
          // are accessed.  The reason we can't use a single autorun
          // for the lifetime of the component is that Tracker only
          // re-runs autoruns at flush time, while we need to be able to
          // re-call getMeteorData synchronously whenever we want, e.g.
          // from componentWillUpdate.
          c.stop();
          // Calling forceUpdate() triggers componentWillUpdate which
          // recalculates getMeteorData() and re-renders the component.
          component.forceUpdate();
        }
      })
    ));

    if (data && Package.mongo && Package.mongo.Mongo) {
      Object.keys(data).forEach((key) => {
        if (data[key] instanceof Package.mongo.Mongo.Cursor) {
          console.warn(
            'Warning: you are returning a Mongo cursor from getMeteorData. '
            + 'This value will not be reactive. You probably want to call '
            + '`.fetch()` on the cursor before returning it.'
          );
        }
      });
    }

    return data;
  }

  updateData(newData) {
    const component = this.component;
    const oldData = this.oldData;

    let failedToGetData = (newData === undefined);
    if (failedToGetData) newData = {};
    // update componentData in place based on newData
    for (let key in newData) {
      component.data[key] = newData[key];
    }
    // if there is oldData (which is every time this method is called
    // except the first), delete keys in oldData that aren't in
    // newData.  don't interfere with other keys, in case we are
    // co-existing with something else that writes to a component's
    // this.data.
    if (oldData) {
      for (let key in oldData) {
        if (!(key in newData)) {
          delete component.data[key];
        }
      }
    }
    this.oldData = newData;
    component.failedToGetData = failedToGetData;
  }
}

export const ReactMeteorData = {
  componentWillMount() {
    this.data = {};
    this._meteorDataManager = new MeteorDataManager(this);
    const newData = this._meteorDataManager.calculateData();
    this._meteorDataManager.updateData(newData);
  },

  componentWillUpdate(nextProps, nextState) {
    const saveProps = this.props;
    const saveState = this.state;
    let newData;
    try {
      // Temporarily assign this.state and this.props,
      // so that they are seen by getMeteorData!
      // This is a simulation of how the proposed Observe API
      // for React will work, which calls observe() after
      // componentWillUpdate and after props and state are
      // updated, but before render() is called.
      // See https://github.com/facebook/react/issues/3398.
      this.props = nextProps;
      this.state = nextState;
      newData = this._meteorDataManager.calculateData();
    } finally {
      this.props = saveProps;
      this.state = saveState;
    }

    this._meteorDataManager.updateData(newData);
  },

  componentWillUnmount() {
    this._meteorDataManager.dispose();
  },

  componentDidCatch(error, info) {
    // It looks like the error gets logged to the console without us having to
    // do anything here.

    // It looks like if we don't setState here, then by default, React leaves
    // this component empty.  That's fine for us and simpler than trying to
    // ignore only the next componentWillUpdate.
  }
};

class ReactComponent extends React.Component {}
Object.assign(ReactComponent.prototype, ReactMeteorData);
class ReactPureComponent extends React.PureComponent {}
Object.assign(ReactPureComponent.prototype, ReactMeteorData);

export default function connect(options) {
  let expandedOptions = options;
  if (typeof options === 'function') {
    expandedOptions = {
      getMeteorData: options,
    };
  }

  const { getMeteorData, pure = true } = expandedOptions;

  const BaseComponent = pure ? ReactPureComponent : ReactComponent;
  return (WrappedComponent) => (
    class ReactMeteorDataComponent extends BaseComponent {
      getMeteorData() {
        return getMeteorData(this.props);
      }
      render() {
        if (this.failedToGetData) {
          // Be consistent with rendering errors.  (<></> would be better if supported.)
          return <span/>;
        }
        return <WrappedComponent {...this.props} {...this.data} />;
      }
    }
  );
}
