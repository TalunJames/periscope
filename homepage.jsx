/* global React */
/* eslint-disable */

const { useState } = React;

function Homepage({ onEnter, accessError, accessBusy, accessErrorMsg, onClearError }) {
  const [accessCode, setAccessCode] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (accessBusy) return;
    if (onEnter) await onEnter(accessCode);
  };

  return (
    <div className="home">
      <div className="home-card">
        <img
          className="home-logo"
          src="/white-stacked.png"
          alt="Fog Signal Strategies"
        />
        <h1 className="home-title">Periscope</h1>
        <p className="home-tagline">Client preview portal</p>

        <form className="home-form" onSubmit={handleSubmit}>
          <label className="home-label" htmlFor="access-code">
            Access code
          </label>
          <input
            id="access-code"
            className="home-input"
            type="text"
            value={accessCode}
            onChange={(e) => {
              setAccessCode(e.target.value);
              if (accessError) onClearError?.();
            }}
            placeholder="Enter your code"
            autoComplete="off"
            spellCheck={false}
            disabled={accessBusy}
          />
          {accessError && (
            <p className="home-error" role="alert">{accessErrorMsg}</p>
          )}
          <button className="home-submit" type="submit" disabled={accessBusy}>
            {accessBusy ? 'Checking…' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  );
}

window.Homepage = Homepage;
