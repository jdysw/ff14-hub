import search from 'bootstrap-icons/icons/search.svg?url';
import gear from 'bootstrap-icons/icons/gear.svg?url';
import star from 'bootstrap-icons/icons/star.svg?url';
import starFill from 'bootstrap-icons/icons/star-fill.svg?url';
const icons={search,gear,star,starFill};
/** Static, bundled Bootstrap Icons; no remote script or runtime icon requests. */
export function UiIcon({name}:{readonly name:keyof typeof icons}){
  return <span className="ui-icon" aria-hidden="true" style={{maskImage:`url("${icons[name]}")`}}/>;
}
