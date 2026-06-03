/* global React */
/* eslint-disable */

const { useState } = React;

function Homepage({ onEnter }) {
  const [accessCode, setAccessCode] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    // Access-code validation will be wired up later.
    if (onEnter) onEnter(accessCode);
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
            onChange={(e) => setAccessCode(e.target.value)}
            placeholder="Enter your code"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="home-submit" type="submit">
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}

window.Homepage = Homepage;
