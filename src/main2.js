import jed from 'jed';

var Jed = new jed({});

var _ = Jed.gettext;
console.log(Jed.gettext('See https://mzl.la/1ZOhoEN (MDN Docs) for more information.'));
console.log(_("asddsaasd"));
function gettext(str) {
	console.log(str);
}
_("asddsaasddsaasddsa");
_("asddsaasddsaasddsa123123123");
