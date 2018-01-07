// Verbose style, specifying gettext args via props
<Message
    id="You have a cat."
    idPlural="You have {cats} cats!"
    comment="User profile description for a public profile"
    count={numCats}
    cats={numCatsFormatted} />
 
// Shortform style, using gettext function directly
<Message i18n={_('Hello World')} />
 
_c('Flag', 'Physical Object');